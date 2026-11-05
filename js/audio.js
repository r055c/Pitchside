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

// The decoder config stored in the file itself (more reliable than one we build).
function fileAsc(mp4, id) {
  try {
    const e = mp4.getTrackById(id).mdia.minf.stbl.stsd.entries[0];
    const d = e.esds && e.esds.esd && e.esds.esd.descs;
    const dc = d && d.find(x => x.tag === 4), ds = dc && dc.descs && dc.descs.find(x => x.tag === 5);
    return ds && ds.data && ds.data.length ? new Uint8Array(ds.data) : null;
  } catch (_) { return null; }
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
  const isAac = track.codec.startsWith('mp4a');
  const real = isAac ? fileAsc(mp4, track.id) : null, built = isAac ? makeAsc(parseInt((track.codec.split('.')[2] || '2'), 10) || 2, rate, ch) : null;
  const tries = [];
  if (isAac) { for (const codec of [...new Set([track.codec, 'mp4a.40.2'])]) for (const d of [real, built, null]) if (d || d === null) tries.push({ codec, sampleRate: rate, numberOfChannels: ch, ...(d ? { description: d } : {}) }); }
  else tries.push({ codec: track.codec, sampleRate: rate, numberOfChannels: ch });
  let cfg = null;
  for (const c of tries) { const r = await AudioDecoder.isConfigSupported(c).catch(() => ({ supported: false })); if (r.supported) { cfg = c; break; } }
  if (!cfg) throw new Error(`Your browser cannot decode this video's sound format (${track.codec}).`);
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
  let nextTs = null, errors = 0, lastErr = null, goodOut = 0;
  const makeDec = () => {
    const d = new AudioDecoder({
      output: ad => {
        try {
          const n = ad.numberOfFrames, t = ad.timestamp / 1e6, mono = new Float32Array(n), tmp = new Float32Array(n);
          for (let c = 0; c < ad.numberOfChannels; c++) { ad.copyTo(tmp, { planeIndex: c, format: 'f32-planar' }); for (let i = 0; i < n; i++) mono[i] += tmp[i] / ad.numberOfChannels; }
          if (nextTs == null) nextTs = t;
          if (t - nextTs > 0.1 && t - nextTs < 600) push(new Float32Array(Math.round((t - nextTs) * rate))); // keep timing across skipped frames
          push(mono); nextTs = t + n / rate; goodOut++;
        } catch (e) { err = e; } finally { ad.close(); }
      },
      error: e => { err = e; },
    });
    d.configure(cfg); return d;
  };
  let dec = makeDec();
  const recover = () => {   // the decoder shut itself down on a bad frame: note it, start a fresh one, carry on
    lastErr = err || lastErr; err = null; errors++;
    if (errors > 60 && goodOut < 50) throw new Error('The sound could not be decoded: ' + (lastErr && lastErr.message || 'unknown error') + ` (${track.codec}, ${rate} Hz, ${ch} ch)`);
    if (dec.state === 'closed') dec = makeDec();
  };

  const WIN = 12 * 1048576; let fed = 0;
  while (fed < order.length) {
    if (signal && signal.aborted) break;
    const before = fed;
    const first = samples[order[fed]], start = first.offset;
    const buf = new Uint8Array(await file.slice(start, Math.min(file.size, start + WIN + 65536)).arrayBuffer());
    while (fed < order.length) {
      const s = samples[order[fed]];
      if (s.offset >= start + WIN || s.offset + s.size > start + buf.length) break;
      const ch1 = new EncodedAudioChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6 / s.timescale), duration: Math.round(s.duration * 1e6 / s.timescale), data: buf.subarray(s.offset - start, s.offset - start + s.size) });
      if (err || dec.state === 'closed') recover();
      try { dec.decode(ch1); } catch (e) { err = err || e; recover(); try { dec.decode(ch1); } catch (e2) { err = e2; } }
      fed++;
      if (dec.decodeQueueSize > 200) await new Promise(r => setTimeout(r, 0));
    }
    while (dec.state !== 'closed' && dec.decodeQueueSize > 0) await new Promise(r => setTimeout(r, 0));
    if (err || dec.state === 'closed') recover();
    while (ready.length) { const c = ready.shift(); await onChunk(c.data, c.start); }
    onProgress(fed / order.length);
    if (fed === before) throw new Error('Sound reader stalled');
  }
  if (!(signal && signal.aborted)) {
    try { await dec.flush(); } catch (e) { err = err || e; }
    if (err) { lastErr = err; err = null; }
    while (ready.length) { const c = ready.shift(); await onChunk(c.data, c.start); }
    if (outN > 0) await onChunk(outBuf.slice(0, outN), emitted / OUT);
  }
  try { dec.close(); } catch (_) {}
  if (goodOut === 0) throw new Error('The sound could not be decoded: ' + (lastErr && lastErr.message || 'no audio came out') + ` (${track.codec}, ${rate} Hz, ${ch} ch)`);
  return { duration: (emitted + outN) / OUT, sampleRate: rate, channels: ch, codec: track.codec, skipped: errors };
}
