// Pitchside ball tracker: runs a football ball detector (an .onnx file) in the browser with ONNX Runtime Web,
// then turns the ball positions into goal candidates. Needs the hosted version (WebGPU/WASM files are loaded
// from js/vendor/ort/). The goal logic below is a port of the Colab notebook's, so both give the same answer.

// ------------------------------------------------------------ small helpers
export function mmss(t) {
  t = Math.round(t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function pctl(sorted, p) { // linear interpolation, same as numpy
  const n = sorted.length; if (!n) return 0;
  const k = (n - 1) * p / 100, f = Math.floor(k), c = Math.min(n - 1, f + 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}
const sortedCol = (pts, i) => pts.map(p => p[i]).sort((a, b) => a - b);

// ------------------------------------------------------------ goal logic (pure, no model needed)
// pts: [[t, x, y, conf], ...] with x, y as 0-1 fractions of the picture.

// Drop spots where the "ball" sits all match long (corner flag, a spare ball), and one-off jumps.
export function cleanTrack(rows, dur) {
  let pts = rows.map(r => r.slice()).sort((a, b) => a[0] - b[0]);
  if (pts.length < 20) return pts;
  const key = (gx, gy) => gx * 100000 + gy;
  const cx = pts.map(p => Math.floor(p[1] / 0.02)), cy = pts.map(p => Math.floor(p[2] / 0.02));
  const cell = new Map(); // occupied cells -> point indexes
  pts.forEach((_, i) => { const k = key(cx[i], cy[i]); (cell.get(k) || cell.set(k, []).get(k)).push(i); });
  const drop = new Set();
  for (const [k, own] of cell) {
    const gx = cx[own[0]], gy = cy[own[0]];
    let n = 0; const win = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const idx = cell.get(key(gx + dx, gy + dy)); if (!idx) continue;
      n += idx.length;
      for (const i of idx) win.add(Math.min(9, Math.floor(pts[i][0] / Math.max(dur, 1) * 10)));
    }
    // a fixed false spot shows up all through the match; a centre spot only around kick-offs
    if (n >= 30 && win.size >= 7) own.forEach(i => drop.add(i));
  }
  pts = pts.filter((_, i) => !drop.has(i));
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0 && i < pts.length - 1) {
      const a = pts[i - 1], b = pts[i + 1];
      const d1 = Math.hypot(p[1] - a[1], p[2] - a[2]), d2 = Math.hypot(p[1] - b[1], p[2] - b[2]), d3 = Math.hypot(a[1] - b[1], a[2] - b[2]);
      if (p[0] - a[0] < 1.5 && b[0] - p[0] < 1.5 && d1 > 0.25 && d2 > 0.25 && d3 < 0.15) continue;
    }
    out.push(p);
  }
  return out;
}

// Guess the two goal areas and the centre spot from where the ball travels. Zones are [x0, x1, y0, y1].
export function suggestZones(pts, endFrac = 0.07) {
  const xs = sortedCol(pts, 1), ys = sortedCol(pts, 2);
  const lo = pctl(xs, 0.5), hi = pctl(xs, 99.5), span = hi - lo;
  const yc = pctl(ys, 50), yr = pctl(ys, 95) - pctl(ys, 5);
  const y0 = yc - 0.2 * yr, y1 = yc + 0.2 * yr, mid = (lo + hi) / 2;
  return {
    left: [0, lo + endFrac * span, y0, y1],      // to the picture edge: anything past the end line is in the net
    right: [hi - endFrac * span, 1, y0, y1],
    centre: [mid - 0.08 * span, mid + 0.08 * span, yc - 0.22 * yr, yc + 0.22 * yr],
  };
}
const inside = (p, z) => p[1] >= z[0] && p[1] <= z[1] && p[2] >= z[2] && p[2] <= z[3];
const ptp = (arr) => Math.max(...arr) - Math.min(...arr);

// Times when the ball sits still on the centre spot (kick-off).
export function restarts(pts, centre, { sampleFps = 5, still = 0.02 } = {}) {
  const need = sampleFps >= 2.5 ? 3 : 2, minSpan = sampleFps >= 2.5 ? 1.5 : 2.5;
  const idx = []; pts.forEach((p, i) => { if (inside(p, centre)) idx.push(i); });
  const out = [];
  for (let a = 0; a < idx.length; a++) {
    const t = pts[idx[a]][0];
    if (out.length && t - out[out.length - 1] < 10) continue;
    const grp = [];
    for (let b = a; b < idx.length && pts[idx[b]][0] - t <= 4.0; b++) grp.push(idx[b]);
    if (grp.length >= need && pts[grp[grp.length - 1]][0] - t >= minSpan
        && ptp(grp.map(j => pts[j][1])) < still && ptp(grp.map(j => pts[j][2])) < still * 1.5) out.push(t);
  }
  return out;
}

// A goal candidate = ball seen in a goal area, then sitting still on the centre spot soon after.
// Each kick-off is given to the most recent goal-area visit before it, so a save then a goal is not counted twice.
export function findCandidates(pts, zones, { minHits = 2, window: rw = [8, 120], sampleFps = 5 } = {}) {
  const clusters = [];
  for (const [name, z] of [['left', zones.left], ['right', zones.right]]) {
    const idx = []; pts.forEach((p, i) => { if (inside(p, z)) idx.push(i); });
    let start = 0;
    for (let k = 1; k <= idx.length; k++) {
      if (k === idx.length || pts[idx[k]][0] - pts[idx[k - 1]][0] > 4.0) {
        const grp = idx.slice(start, k); start = k;
        if (grp.length >= minHits) clusters.push({ time: pts[grp[0]][0], t1: pts[grp[grp.length - 1]][0], end: name, hits: grp.length, restartAt: null });
      }
    }
  }
  for (const r of restarts(pts, zones.centre, { sampleFps })) {
    const ok = clusters.filter(c => c.t1 + rw[0] <= r && r <= c.t1 + rw[1]);
    if (ok.length) {
      const best = ok.reduce((a, b) => (b.t1 > a.t1 ? b : a));
      if (best.restartAt == null) best.restartAt = r;
    }
  }
  for (const c of clusters) {
    c.restart = c.restartAt != null;
    c.score = Math.round((0.4 + 0.2 * Math.min(c.hits, 6) / 6 + (c.restart ? 0.4 : 0)) * 100) / 100;
  }
  clusters.sort((a, b) => a.time - b.time);
  const merged = [];
  for (const c of clusters) {
    if (merged.length && c.time - merged[merged.length - 1].time < 25) {
      if (c.restart && !merged[merged.length - 1].restart) merged[merged.length - 1] = c;
      continue;
    }
    merged.push(c);
  }
  return merged;
}

// ------------------------------------------------------------ reading the model's output
// YOLO ONNX output is [1, 4+classes, N] (boxes as cx, cy, w, h then one score per class), or the transpose.
// Returns the most confident ball as { x, y, conf } (x, y as 0-1 fractions) or null.
export function parseOutput(data, dims, { ballClass = null, conf = 0.15, W = 640, H = 640 } = {}) {
  if (!dims || dims.length < 3) return null;
  const first = dims[1] < dims[2];              // channels first: [1, C, N]
  const C = first ? dims[1] : dims[2], N = first ? dims[2] : dims[1];
  const nc = C - 4; if (nc < 1) return null;
  if (ballClass == null) ballClass = nc === 3 ? 1 : nc === 80 ? 32 : 0; // soccana (player, ball, referee) and COCO "sports ball"
  if (ballClass >= nc) ballClass = 0;
  const at = first ? (c, i) => data[c * N + i] : (c, i) => data[i * C + c];
  let best = -1, bi = -1;
  for (let i = 0; i < N; i++) { const s = at(4 + ballClass, i); if (s > best) { best = s; bi = i; } }
  if (bi < 0 || best < conf) return null;
  let x = at(0, bi), y = at(1, bi);
  if (x > 1.5 || y > 1.5) { x /= W; y /= H; }   // pixel coordinates -> fractions
  if (!(x >= 0 && x <= 1.2 && y >= 0 && y <= 1.2)) return null;
  return { x: Math.min(1, x), y: Math.min(1, y), conf: best };
}

// ------------------------------------------------------------ ONNX Runtime Web
let ortPromise = null;
function base() { return new URL('js/vendor/ort/', document.baseURI).href; }
export function getOrt() {
  if (!ortPromise) {
    ortPromise = import(base() + 'ort.webgpu.min.mjs').then(ort => {
      ort.env.wasm.wasmPaths = base();
      ort.env.wasm.numThreads = 1;
      return ort;
    }).catch(() => {
      ortPromise = null;
      throw new Error('The ball tracker needs the hosted version of Pitchside (the web address), not the single file. Open it from the Vercel link.');
    });
  }
  return ortPromise;
}
export async function hasWebGPU() {
  try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (_) { return false; }
}

// buffer: ArrayBuffer/Uint8Array of the .onnx file. Returns { run(frameCanvasCtx...), ... } used by scanBall.
export async function loadBallSession(buffer, { prefer = 'auto', onStatus = () => {} } = {}) {
  const ort = await getOrt();
  const gpu = prefer === 'wasm' ? false : await hasWebGPU();
  const order = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  let last = null;
  for (const ep of order) {
    try {
      onStatus(ep === 'webgpu' ? 'Loading the model on your graphics chip…' : 'Loading the model (CPU, this will be slow)…');
      const session = await ort.InferenceSession.create(buffer, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      const inName = session.inputNames[0], outName = session.outputNames[0];
      let W = 1280, H = 1280;
      try {
        const md = session.inputMetadata; const mi = Array.isArray(md) ? md[0] : md && md[inName];
        const sh = mi && mi.shape; if (sh && sh.length === 4) { if (Number.isInteger(sh[3]) && sh[3] > 0) W = sh[3]; if (Number.isInteger(sh[2]) && sh[2] > 0) H = sh[2]; }
      } catch (_) {}
      const sess = { ort, session, ep, inName, outName, W, H, buf: new Float32Array(3 * W * H) };
      sess.buf.fill(0.5);
      onStatus('Warming up…');
      await detectOnce(sess, null, {}); // first run compiles shaders; also proves this provider works
      return sess;
    } catch (e) { last = e; }
  }
  throw new Error('Could not load that model: ' + (last && last.message ? last.message : last));
}

// Run the model once on a canvas (or a blank frame when canvas is null). Returns { x, y, conf } or null.
export async function detectOnce(sess, canvasCtx, opts) {
  const { ort, session, inName, outName, W, H, buf } = sess;
  if (canvasCtx) {
    const px = canvasCtx.getImageData(0, 0, W, H).data, n = W * H;
    for (let i = 0, j = 0; i < n; i++, j += 4) { buf[i] = px[j] / 255; buf[n + i] = px[j + 1] / 255; buf[2 * n + i] = px[j + 2] / 255; }
  }
  const out = await session.run({ [inName]: new ort.Tensor('float32', buf, [1, 3, H, W]) });
  const t = out[outName];
  const r = parseOutput(t.data, t.dims, { ...opts, W, H });
  if (t.dispose) try { t.dispose(); } catch (_) {}
  return r;
}

// Play the video once, sampling frames and running the detector on them. The video speed adapts so the
// detector keeps up. Returns { rows: [[t, x, y, conf]...], duration, partial, coveredTo, provider }.
export async function scanBall(file, sess, { sampleFps = 2, conf = 0.15, ballClass = null, onProgress = () => {}, signal } = {}) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.playsInline = true; v.setAttribute('playsinline', ''); v.muted = true; v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none';
  v.src = url; document.body.appendChild(v);
  const cv = document.createElement('canvas'); cv.width = sess.W; cv.height = sess.H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let wake = null, onVis = null, stall = 0;
  const cleanup = () => {
    clearInterval(stall); if (onVis) document.removeEventListener('visibilitychange', onVis);
    try { v.pause(); } catch (_) {}
    v.removeAttribute('src'); try { v.load(); } catch (_) {} v.remove(); URL.revokeObjectURL(url);
    if (wake) try { wake.release(); } catch (_) {}
  };
  try {
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("This video format can't be read by your browser. Try an .mp4 (H.264) file.")); });
    const duration = v.duration;
    if (!isFinite(duration) || duration < 20) throw new Error('That video looks too short or unreadable.');
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (_) {}
    const interval = 1 / sampleFps, rows = [];
    let busy = false, lastT = -1e9, lastFrame = performance.now(), covered = 0, avg = 0.4, n = 0, hidden = document.hidden;
    const t0 = performance.now();
    let done = false, finish = null;
    const end = new Promise(res => { finish = res; });
    const setRate = () => { v.playbackRate = Math.max(0.0625, Math.min(8, interval / Math.max(avg, 0.02))); };
    onVis = () => { hidden = document.hidden; if (hidden) v.pause(); else if (!done) v.play().catch(() => {}); };
    document.addEventListener('visibilitychange', onVis);
    const report = () => {
      const wall = (performance.now() - t0) / 1000, speed = covered > 5 ? covered / wall : null;
      onProgress({ t: covered, duration, frac: covered / duration, sightings: rows.length, samples: n, ms: avg * 1000, hidden,
                   etaSec: speed ? (duration - covered) / speed : null, rate: v.playbackRate });
    };
    const onFrame = async (now, meta) => {
      if (done) return;
      lastFrame = performance.now();
      const t = meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : v.currentTime;
      covered = Math.max(covered, t);
      if (!busy && t - lastT >= interval - 0.02) {
        busy = true; lastT = t;
        ctx.drawImage(v, 0, 0, sess.W, sess.H);               // grab the frame now, before the video moves on
        const s0 = performance.now();
        try {
          const d = await detectOnce(sess, ctx, { conf, ballClass });
          if (d) rows.push([t, d.x, d.y, d.conf]);
          n++; avg = n < 3 ? (performance.now() - s0) / 1000 : avg * 0.85 + 0.15 * (performance.now() - s0) / 1000; setRate();
        } catch (e) { done = true; finish({ error: e }); return; }
        busy = false; report();
      }
      if (!done) v.requestVideoFrameCallback(onFrame);
    };
    v.onended = () => { if (!done) { done = true; finish({}); } };
    if (signal) signal.addEventListener('abort', () => { if (!done) { done = true; finish({ aborted: true }); } });
    stall = setInterval(() => { if (!done && !hidden && !v.paused && performance.now() - lastFrame > 20000 && !busy) { done = true; finish({ stalled: true }); } }, 2000);
    v.requestVideoFrameCallback(onFrame);
    setRate(); await v.play();
    const res = await end;
    if (res.error) throw res.error;
    const partial = !!(res.aborted || res.stalled) && covered < duration - 5;
    return { rows, duration, partial, coveredTo: covered, provider: sess.ep };
  } finally { cleanup(); }
}
