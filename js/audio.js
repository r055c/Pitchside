// Fast audio reader: pulls the sound out of an MP4/MOV video without playing it, using the browser's own audio
// decoder (WebCodecs, in Chrome and Edge). Streams 16 kHz mono chunks to a callback, so a 52-minute match takes about
// a minute instead of 52. Other video types are not supported by this path.

const base = () => new URL('js/vendor/mp4box/', document.baseURI).href;
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export function audioSupported() { return typeof AudioDecoder !== 'undefined'; }

// AAC "AudioSpecificConfig" built from the codec string (mp4a.40.2), sample rate and channel count.
function makeAsc(aot, rate, ch) {
  const idx = RATES.indexOf(rate); if (idx < 0) return null;
  const v = (aot << 11) | (idx << 7) | (ch << 3);
  return new Uint8Array([v >> 8, v & 255]);
}

async function readMoov(file, MP4) {
  const mp4 = MP4.createFile(false);
  let info = null; mp4.onReady = i => { info = i; }; mp4.onError = () => {};
  let pos = 0, guard = 0;
  while (!info && pos != null && pos < file.size && guard++ < 60) {
    const end = Math.min(file.size, pos + 4 * 1048576);
    const buf = await file.slice(pos, end).arrayBuffer(); buf.fileStart = pos;
    const next = mp4.appendBuffer(buf);
    if (info) break;
    pos = typeof next === 'number' && next > pos ? next : end;
  }
  if (!info) throw new Error("Could not read this video's structure. The sound reader needs an .mp4 or .mov file.");
  return { mp4, info };
}

// onChunk(Float32Array mono 16 kHz, startSeconds) is awaited, so slow consumers apply back-pressure.
export async function decodeAudio(file, { chunkSeconds = 48, onChunk, onProgress = () => {}, signal } = {}) {
  if (!audioSupported()) throw new Error('This needs Chrome or Edge on a computer (your browser cannot decode sound this way).');
  const MP4 = await import(base() + 'mp4box.all.mjs');
  const { mp4, info } = await readMoov(file, MP4);
  const track = info.audioTracks && info.audioTracks[0];
  if (!track) throw new Error('This video has no sound track.');
  const rate = track.audio.sample_rate, ch = track.audio.channel_count;
  const cfg = { codec: track.codec.startsWith('mp4a') ? 'mp4a.40.2' : track.codec, sampleRate: rate, numberOfChannels: ch };
  if (track.codec.startsWith('mp4a')) {
    const aot = parseInt((track.codec.split('.')[2] || '2'), 10) || 2, asc = makeAsc(aot, rate, ch);
    if (asc) cfg.description = asc;
  }
  const sup = await AudioDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
  if (!sup.supported) throw new Error(`Your browser cannot decode this video's sound format (${track.codec}).`);
  const samples = (mp4.getTrackSamplesInfo ? mp4.getTrackSamplesInfo(track.id) : null) || [];
  if (!samples.length) throw new Error('Could not find the sound samples in this video.');
  const order = samples.map((s, i) => i).sort((a, b) => samples[a].offset - samples[b].offset);

  // streaming resampler to 16 kHz mono (area average)
  const OUT = 16000, ratio = rate / OUT, perChunk = Math.round(chunkSeconds * OUT);
  let acc = new Float32Array(0), carry = 0 /* source samples already consumed */, outBuf = new Float32Array(perChunk), outN = 0, emitted = 0;
  const ready = []; let err = null;
  const push = (mono) => {                                   // mono at source rate -> 16 kHz appended to outBuf
    const src = acc.length ? (() => { const a = new Float32Array(acc.length + mono.length); a.set(acc); a.set(mono, acc.length); return a; })() : mono;
    let p = carry, n = 0;
    while (p + ratio <= src.length) {
      const i0 = Math.floor(p), i1 = Math.floor(p + ratio); let s = 0, c = 0;
      for (let i = i0; i < i1; i++) { s += src[i]; c++; }
      outBuf[outN++] = c ? s / c : 0; p += ratio; n++;
      if (outN === perChunk) { ready.push({ data: outBuf, start: emitted / OUT }); emitted += perChunk; outBuf = new Float32Array(perChunk); outN = 0; }
    }
    const keep = Math.floor(p); acc = src.slice(keep); carry = p - keep;
  };
  const dec = new AudioDecoder({
    output: ad => {
      try {
        const n = ad.numberOfFrames, mono = new Float32Array(n), tmp = new Float32Array(n);
        for (let c = 0; c < ad.numberOfChannels; c++) { ad.copyTo(tmp, { planeIndex: c, format: 'f32-planar' }); for (let i = 0; i < n; i++) mono[i] += tmp[i] / ad.numberOfChannels; }
        push(mono);
      } catch (e) { err = e; } finally { ad.close(); }
    },
    error: e => { err = e; },
  });
  dec.configure(cfg);

  const WIN = 12 * 1048576; let fed = 0;
  while (fed < order.length) {
    if (signal && signal.aborted) break;
    const before = fed;
    const first = samples[order[fed]], start = first.offset;
    const buf = new Uint8Array(await file.slice(start, Math.min(file.size, start + WIN + 65536)).arrayBuffer());
    while (fed < order.length) {
      const s = samples[order[fed]];
      if (s.offset >= start + WIN || s.offset + s.size > start + buf.length) break;
      dec.decode(new EncodedAudioChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6 / s.timescale), duration: Math.round(s.duration * 1e6 / s.timescale), data: buf.subarray(s.offset - start, s.offset - start + s.size) }));
      fed++;
      if (dec.decodeQueueSize > 200) await new Promise(r => setTimeout(r, 0));
    }
    while (dec.decodeQueueSize > 0) await new Promise(r => setTimeout(r, 0));
    if (err) throw err;
    while (ready.length) { const c = ready.shift(); await onChunk(c.data, c.start); }
    onProgress(fed / order.length);
    if (fed === before) throw new Error('Sound reader stalled');
  }
  if (!(signal && signal.aborted)) {
    await dec.flush(); if (err) throw err;
    while (ready.length) { const c = ready.shift(); await onChunk(c.data, c.start); }
    if (outN > 0) await onChunk(outBuf.slice(0, outN), emitted / OUT);
  }
  try { dec.close(); } catch (_) {}
  return { duration: (emitted + outN) / OUT, sampleRate: rate, channels: ch, codec: track.codec };
}
