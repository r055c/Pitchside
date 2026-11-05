// Cheering / crowd / whistle detector: runs Google's YAMNet sound classifier (an .onnx file, Apache-2.0) over the
// match sound. The model is downloaded once from Hugging Face by your browser and kept on this device, or you can
// pick the file yourself. Needs the hosted version (it uses the ONNX Runtime files in js/vendor/ort/).
import { getOrt } from './ball.js';
import { decodeAudio } from './audio.js';

export const YAMNET_URL = 'https://huggingface.co/audiomagic/yamnet-onnx/resolve/main/yamnet.onnx';
// AudioSet class numbers in YAMNet's 521-class list
export const CLS = { speech: 0, shout: 6, yell: 9, cheer: 61, applause: 62, crowd: 64, whistle: 396 };
export const HOP = 0.48;           // seconds between frames
const FRAME = 15360, STEP = 7680;  // 0.96 s window, 0.48 s hop at 16 kHz

export async function loadYamnet(buffer, { onStatus = () => {} } = {}) {
  const ort = await getOrt();
  onStatus('Loading the sound model…');
  const session = await ort.InferenceSession.create(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const inName = session.inputNames[0], outName = session.outputNames[0];
  const sess = { ort, session, inName, outName };
  const warm = await classify(sess, new Float32Array(FRAME * 3));  // proves the model runs here
  if (!warm || !warm.dims || warm.dims[warm.dims.length - 1] !== 521) throw new Error('That does not look like the YAMNet model (expected 521 sound classes).');
  return sess;
}

// waveform (16 kHz mono) -> { data: Float32Array frames*521, dims }
export async function classify(sess, wave) {
  const out = await sess.session.run({ [sess.inName]: new sess.ort.Tensor('float32', wave, [wave.length]) });
  const t = out[sess.outName];
  return { data: t.data, dims: t.dims };
}

// Scan a whole match. Returns { hop, cheer, applause, crowd, shout, whistle, speech } as arrays of 0-255 values.
export async function scanSound(file, sess, { onProgress = () => {}, signal } = {}) {
  const keys = { cheer: [CLS.cheer], applause: [CLS.applause], crowd: [CLS.crowd], shout: [CLS.shout, CLS.yell], whistle: [CLS.whistle], speech: [CLS.speech] };
  const series = {}; for (const k in keys) series[k] = [];
  let frames = 0;
  const info = await decodeAudio(file, {
    chunkSeconds: 48, signal,
    onProgress: f => onProgress({ frac: f, seconds: frames * HOP }),
    onChunk: async (wave, start) => {
      if (wave.length < FRAME) return;
      const r = await classify(sess, wave), n = r.dims[0], C = r.dims[r.dims.length - 1];
      const base = Math.round(start / HOP);
      while (frames < base) { for (const k in series) series[k].push(series[k].length ? series[k][series[k].length - 1] : 0); frames++; } // gap between chunks
      for (let i = 0; i < n; i++) {
        for (const k in keys) { let v = 0; for (const c of keys[k]) v = Math.max(v, r.data[i * C + c]); series[k].push(Math.max(0, Math.min(255, Math.round(v * 255)))); }
        frames++;
      }
    },
  });
  return { hop: HOP, duration: info.duration, ...series };
}

// ---- keep the model on this device (Cache API) ----
const KEEP = 'pitchside-keep', KEY = '/__pitchside_yamnet';
export async function savedYamnet() {
  try { const c = await caches.open(KEEP), r = await c.match(KEY); return r ? await r.arrayBuffer() : null; } catch (_) { return null; }
}
export async function keepYamnet(buffer) {
  try { const c = await caches.open(KEEP); await c.put(KEY, new Response(buffer)); } catch (_) {}
}
// Try the saved copy, then Hugging Face. Returns an ArrayBuffer or throws a friendly error.
export async function getYamnetBuffer(onStatus = () => {}) {
  const saved = await savedYamnet(); if (saved) return saved;
  onStatus('Downloading the sound model (about 15 MB, once)…');
  let res; try { res = await fetch(YAMNET_URL); } catch (_) { throw new Error('NEEDFILE: Could not download the sound model (Hugging Face may be blocked here). Download yamnet.onnx yourself and choose it.'); }
  if (!res.ok) throw new Error('NEEDFILE: Could not download the sound model (' + res.status + '). Download yamnet.onnx yourself and choose it.');
  const buf = await res.arrayBuffer(); await keepYamnet(buf); return buf;
}
