// Pitchside scan engine.
// scanVideo(): plays the match video fast in a hidden <video>, sampling audio (Web Audio) and
//              frames (canvas) twice per second of match time. Nothing leaves the device.
// processSignals(): pure maths - turns the raw samples into highlight moments + momentum curves.

export const DEFAULTS = { sampleFps: 2, pre: 10, post: 6, minGap: 30, minScore: 0.8, maxClipsMult: 1, maxClips: 0 };

// ---------------------------------------------------------------- maths helpers
const zeros = n => new Float64Array(n);
function median(a) {
  const b = Float64Array.from(a).sort();
  const n = b.length;
  if (!n) return 0;
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
}
function std(a) {
  const n = a.length; if (!n) return 0;
  let m = 0; for (const v of a) m += v; m /= n;
  let s = 0; for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / n);
}
export function percentile(a, p) {
  const b = Float64Array.from(a).sort();
  const n = b.length; if (!n) return 0;
  const pos = (n - 1) * p / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
  return b[lo] + (b[hi] - b[lo]) * (pos - lo);
}
// robust z-score, clipped to [-3, 8]
function rz(x) {
  const med = median(x);
  const dev = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) dev[i] = Math.abs(x[i] - med);
  let mad = median(dev) * 1.4826;
  if (mad < 1e-9) mad = std(x) + 1e-9;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.min(8, Math.max(-3, (x[i] - med) / mad));
  return out;
}
// moving average with edge padding (same alignment as numpy version)
function smooth(x, n) {
  n = Math.max(1, Math.floor(n));
  const L = x.length;
  if (n === 1 || L < n) return Float64Array.from(x);
  const left = n >> 1, right = n - 1 - left;
  const pre = new Float64Array(L + 1);
  for (let i = 0; i < L; i++) pre[i + 1] = pre[i] + x[i];
  const out = new Float64Array(L);
  for (let i = 0; i < L; i++) {
    const a = i - left, b = i + right;
    const lo = Math.max(a, 0), hi = Math.min(b, L - 1);
    let sum = pre[hi + 1] - pre[lo];
    if (a < 0) sum += x[0] * (-a);
    if (b > L - 1) sum += x[L - 1] * (b - (L - 1));
    out[i] = sum / n;
  }
  return out;
}
function fillGaps(arr, has, fallback) {
  // forward-fill samples that never got a value
  let last = null;
  for (let i = 0; i < arr.length; i++) {
    if (has[i]) last = arr[i];
    else if (last !== null) arr[i] = last;
  }
  // leading gap: back-fill from first real value
  let first = -1;
  for (let i = 0; i < arr.length; i++) if (has[i]) { first = i; break; }
  if (first === -1) { arr.fill(fallback); return; }
  for (let i = 0; i < first; i++) arr[i] = arr[first];
}

// ---------------------------------------------------------------- signals -> moments + curves
export function processSignals(raw, duration, o = {}) {
  const opt = { ...DEFAULTS, ...o };
  const fps = opt.sampleFps;
  const N = Math.min(raw.pan.length, Math.ceil(duration * fps));
  const sl = a => Float64Array.from(a).subarray(0, N);
  const pan = sl(raw.pan), resid = sl(raw.resid);
  const hasAudio = !!(raw.loud && raw.whistle);
  const t = new Float64Array(N); for (let i = 0; i < N; i++) t[i] = i / fps;

  const absPan = pan.map(Math.abs);
  const fResid = smooth(rz(resid), 3);
  const fPan = smooth(rz(absPan), 3);
  const fLoud = hasAudio ? smooth(rz(sl(raw.loud)), 3) : zeros(N);
  const fWhistle = hasAudio ? rz(sl(raw.whistle)) : zeros(N);
  const w = hasAudio ? { loud: 0.40, whistle: 0.15, resid: 0.25, pan: 0.20 } : { loud: 0, whistle: 0, resid: 0.55, pan: 0.45 };

  // ignore the first few seconds: decoding/audio start-up glitches look like action
  const warm = Math.min(N, Math.ceil(3 * fps));
  for (let i = 0; i < warm; i++) { fResid[i] = 0; fPan[i] = 0; fLoud[i] = 0; fWhistle[i] = 0; }
  let score = new Float64Array(N);
  for (let i = 0; i < N; i++) score[i] = w.loud * fLoud[i] + w.whistle * fWhistle[i] + w.resid * fResid[i] + w.pan * fPan[i];
  score = smooth(score, 3);

  // --- highlight candidates
  const base = Math.max(6, Math.min(25, Math.floor(duration / 60 * 0.6) + 4));
  const maxN = opt.maxClips || Math.max(3, Math.round(base * opt.maxClipsMult));
  const thresh = Math.max(opt.minScore, percentile(score, 90));
  const order = Array.from(score.keys()).sort((a, b) => score[b] - score[a]);
  const chosen = [];
  for (const i of order) {
    if (score[i] < thresh || chosen.length >= maxN) break;
    if (chosen.every(j => Math.abs(t[i] - t[j]) >= opt.minGap)) chosen.push(i);
  }
  chosen.sort((a, b) => a - b);
  const events = chosen.map((i, k) => {
    const kinds = { loud: fLoud[i] * w.loud, whistle: fWhistle[i] * w.whistle, motion: fResid[i] * w.resid + fPan[i] * w.pan };
    const main = Object.keys(kinds).reduce((a, b) => kinds[a] >= kinds[b] ? a : b);
    const label = { loud: 'Crowd or shouting spike', whistle: 'Whistle', motion: 'Fast play or camera sweep' }[main];
    return { id: k + 1, time: t[i], start: Math.max(0, t[i] - opt.pre), end: Math.min(duration, t[i] + opt.post),
             score: Math.round(score[i] * 100) / 100, label, type: null, side: null };
  });

  // --- momentum curves (experimental): where the play is, relative to the direction we attack
  const act = smooth(Array.from({ length: N }, (_, i) => Math.max(0, fResid[i]) + Math.max(0, fPan[i]) + 0.5 * Math.max(0, fLoud[i])), 5);
  const pos = new Float64Array(N);
  let acc = 0; for (let i = 0; i < N; i++) { acc += pan[i]; pos[i] = acc; }
  const win = Math.floor(90 * fps) | 1;
  const trend = smooth(pos, win);
  const posRel = new Float64Array(N);
  for (let i = 0; i < N; i++) posRel[i] = pos[i] - trend[i];
  const p95 = percentile(posRel.map(Math.abs), 95) + 1e-9;
  const half = opt.halfTime && opt.halfTime > 0 ? opt.halfTime : duration / 2;
  const right = opt.attackDir !== 'left';
  const usRaw = new Float64Array(N), themRaw = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const dir = (t[i] < half) ? (right ? 1 : -1) : (right ? -1 : 1);
    const side = Math.max(-1, Math.min(1, posRel[i] / p95 * dir));
    usRaw[i] = act[i] * (0.25 + 0.75 * Math.max(0, side));
    themRaw[i] = act[i] * (0.25 + 0.75 * Math.max(0, -side));
  }
  const sw = Math.floor(20 * fps);
  const us = smooth(usRaw, sw), them = smooth(themRaw, sw);
  let mx = 1e-9; for (let i = 0; i < N; i++) mx = Math.max(mx, us[i], them[i]);
  const ds = Math.max(1, Math.floor(5 * fps));
  const curves = { t: [], us: [], them: [] };
  for (let i = 0; i < N; i += ds) {
    curves.t.push(Math.round(t[i] * 10) / 10);
    curves.us.push(Math.round(us[i] / mx * 1000) / 10);
    curves.them.push(Math.round(them[i] / mx * 1000) / 10);
  }
  return { events, curves, hasAudio, half };
}

// ---------------------------------------------------------------- frame comparison (pan + leftover motion)
const FW = 160, FH = 90;
function compareFrames(prev, cur) {
  const W = FW, H = FH;
  const cx = new Float32Array(W), px = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) { cx[x] += cur[o + x]; px[x] += prev[o + x]; }
  }
  for (let x = 0; x < W; x++) { cx[x] /= H; px[x] /= H; }
  const maxS = Math.round(W * 0.12);
  let best = 0, bestE = Infinity;
  for (let s = -maxS; s <= maxS; s++) {
    let e = 0;
    for (let x = maxS; x < W - maxS; x++) e += Math.abs(cx[x] - px[x - s]);
    if (e < bestE) { bestE = e; best = s; }
  }
  const m = 6;
  let sum = 0, n = 0;
  for (let y = m; y < H - m; y++) {
    const o = y * W;
    for (let x = maxS; x < W - maxS; x++) { sum += Math.abs(cur[o + x] - prev[o + x - best]); n++; }
  }
  return { pan: -best / W, resid: sum / Math.max(1, n) };
}

// ---------------------------------------------------------------- the scan
export async function probeVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'metadata'; v.muted = true; v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('unreadable')); });
    return { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  } finally { URL.revokeObjectURL(url); }
}

export async function scanVideo(file, { rate = 4, sampleFps = 2, onProgress = () => {}, signal } = {}) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none';
  v.src = url;
  document.body.appendChild(v);

  // Audio graph is built synchronously (inside the tap that started the scan) so browsers allow it.
  // The analyser is deliberately NOT connected to the speakers: the scan is silent.
  let ac = null, an = null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ac = new AC();
    const src = ac.createMediaElementSource(v);
    an = ac.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0;
    src.connect(an);
    if (ac.resume) ac.resume();
  } catch (e) { ac = null; an = null; v.muted = true; }

  let wake = null;
  const cleanup = () => {
    clearInterval(tAudio); clearInterval(tProg); clearInterval(tFrame);
    try { v.pause(); } catch (_) {}
    v.removeAttribute('src'); try { v.load(); } catch (_) {}
    v.remove(); URL.revokeObjectURL(url);
    if (ac) try { ac.close(); } catch (_) {}
    if (wake) try { wake.release(); } catch (_) {}
  };
  let tAudio = 0, tProg = 0, tFrame = 0;

  try {
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error("This video format can't be read by your browser. Try an .mp4 (H.264) file."));
    });
    const duration = v.duration;
    if (!isFinite(duration) || duration < 20) throw new Error('That video looks too short or unreadable.');
    const N = Math.ceil(duration * sampleFps) + 2;
    const pan = new Float64Array(N), resid = new Float64Array(N), hasF = new Uint8Array(N);
    const loudSq = new Float64Array(N), loudN = new Uint32Array(N), whis = new Float64Array(N).fill(-Infinity);
    let maxMs = 0;

    // ---- audio ticks
    if (an) {
      const tbuf = new Float32Array(an.fftSize), fbuf = new Float32Array(an.frequencyBinCount);
      const binHz = ac.sampleRate / an.fftSize;
      const lo = Math.max(1, Math.floor(2000 / binHz)), hi = Math.min(fbuf.length - 1, Math.ceil(4500 / binHz));
      const band = new Float32Array(hi - lo + 1);
      tAudio = setInterval(() => {
        if (v.paused) return;
        const b = Math.floor(v.currentTime * sampleFps); if (b < 0 || b >= N) return;
        an.getFloatTimeDomainData(tbuf);
        let s = 0; for (let i = 0; i < tbuf.length; i++) s += tbuf[i] * tbuf[i];
        const ms = s / tbuf.length;
        loudSq[b] += ms; loudN[b]++; if (ms > maxMs) maxMs = ms;
        an.getFloatFrequencyData(fbuf);
        let peak = -Infinity;
        for (let i = lo; i <= hi; i++) { const d = fbuf[i]; band[i - lo] = d; if (d > peak) peak = d; }
        const med = median(band);
        if (isFinite(peak) && isFinite(med)) { const r = peak - med; if (r > whis[b]) whis[b] = r; }
      }, 25);
    }

    // ---- frame sampling
    const cv = document.createElement('canvas'); cv.width = FW; cv.height = FH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    let prev = null, lastBin = -1, lastResid = 0;
    const grab = () => {
      ctx.drawImage(v, 0, 0, FW, FH);
      const d = ctx.getImageData(0, 0, FW, FH).data;
      const g = new Float32Array(FW * FH);
      for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      return g;
    };
    const sample = mediaTime => {
      const b = Math.floor(mediaTime * sampleFps);
      if (b <= lastBin || b >= N) return;
      const g = grab();
      if (prev) { const r = compareFrames(prev, g); pan[b] = r.pan; resid[b] = r.resid; lastResid = r.resid; }
      hasF[b] = 1; prev = g; lastBin = b;
    };
    if ('requestVideoFrameCallback' in v) {
      const cb = (_n, meta) => { sample(meta.mediaTime); if (!finished) v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      tFrame = setInterval(() => { if (!v.paused) sample(v.currentTime); }, 80);
    }

    // ---- run
    let finished = false, resolveEnd; const ended = new Promise(r => resolveEnd = r);
    const finish = why => { if (!finished) { finished = true; resolveEnd(why); } };
    v.onended = () => finish('ended');
    v.onerror = () => finish('error');
    if (signal) signal.addEventListener('abort', () => finish('abort'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !finished && v.paused) v.play().catch(() => {}); });
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (_) {}

    v.playbackRate = rate; v.preservesPitch = true;
    const t0 = performance.now();
    await v.play();
    let lastT = -1, stalled = 0;
    tProg = setInterval(() => {
      const ct = v.currentTime;
      if (Math.abs(ct - lastT) < 0.01) stalled += 0.4; else stalled = 0;
      lastT = ct;
      if (stalled >= 15 && v.paused) v.play().catch(() => {});
      if (stalled >= 45) finish('stalled');
      if (ct >= duration - 0.3) finish('ended');
      onProgress({ frac: Math.min(1, ct / duration), t: ct, duration, elapsed: (performance.now() - t0) / 1000, resid: lastResid, bin: lastBin });
    }, 400);

    const why = await ended;
    if (why === 'abort') throw new DOMException('Scan cancelled', 'AbortError');
    if (why === 'error') throw new Error('The video stopped playing part-way through.');
    const covered = Math.max(0, Math.min(duration, v.currentTime));
    const partial = why === 'stalled' && covered < duration - 5;

    // ---- tidy the raw samples
    const n = Math.ceil(duration * sampleFps);
    const anyAudio = an && maxMs > 1e-9;
    const loud = new Float64Array(N), whistle = new Float64Array(N), hasA = new Uint8Array(N), hasW = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (loudN[i]) { loud[i] = 10 * Math.log10(loudSq[i] / loudN[i] + 1e-12); hasA[i] = 1; }
      if (isFinite(whis[i])) { whistle[i] = whis[i]; hasW[i] = 1; }
    }
    fillGaps(pan, hasF, 0); fillGaps(resid, hasF, 0);
    if (anyAudio) { fillGaps(loud, hasA, -80); fillGaps(whistle, hasW, 0); }
    const r3 = a => Array.from(a.subarray(0, n), x => Math.round(x * 1000) / 1000);
    return {
      duration, partial, coveredTo: covered, hasAudio: !!anyAudio, sampleFps,
      raw: { pan: r3(pan), resid: r3(resid), loud: anyAudio ? r3(loud) : null, whistle: anyAudio ? r3(whistle) : null }
    };
  } finally { cleanup(); }
}
