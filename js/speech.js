// Spoken-"goal" detector: runs the Whisper speech recogniser (tiny English model) in your browser over the match
// sound and notes when someone says "goal" or similar. The model (about 40 MB) is downloaded once from Hugging Face by
// your browser and kept by it. Needs the hosted version (runtime files are in js/vendor/hf/).
import { decodeAudio } from './audio.js';
import { isGoalTalk, isStrongGoalTalk } from './fuse.js';

export const WHISPER_MODEL = 'onnx-community/whisper-tiny.en';
let lib = null;

export async function loadWhisper({ onStatus = () => {}, onProgress = () => {} } = {}) {
  if (!lib) {
    const base = new URL('js/vendor/hf/', document.baseURI).href;
    try { lib = await import(base + 'transformers.min.js'); } catch (e) {
      throw new Error('The speech detector needs the hosted version of Pitchside (the web address), not the single file.');
    }
    lib.env.allowLocalModels = false; lib.env.useBrowserCache = true;
    lib.env.backends.onnx.wasm.wasmPaths = base; lib.env.backends.onnx.wasm.numThreads = 1; lib.env.backends.onnx.wasm.proxy = false;
  }
  onStatus('Loading the speech model (about 40 MB the first time)…');
  try {
    return await lib.pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      dtype: 'q8', device: 'wasm',
      progress_callback: p => { if (p && p.status === 'progress' && p.total) onProgress(p.loaded / p.total); },
    });
  } catch (e) {
    throw new Error('Could not download the speech model (Hugging Face may be blocked here). ' + (e && e.message ? e.message : ''));
  }
}

// asr: a function (Float32Array 16 kHz mono) -> { text, chunks: [{ text, timestamp: [start, end] }] }
export async function scanSpeech(file, asr, { onProgress = () => {}, signal } = {}) {
  const hits = []; let words = 0, chunks = 0, skipped = 0;
  await decodeAudio(file, {
    chunkSeconds: 30, signal,
    onProgress: f => onProgress({ frac: f, hits: hits.length }),
    onChunk: async (wave, start) => {
      if (signal && signal.aborted) return;
      let e = 0; for (let i = 0; i < wave.length; i += 16) e += wave[i] * wave[i];
      if (Math.sqrt(e / (wave.length / 16)) < 0.004) { skipped++; return; }          // silence
      const r = await asr(wave, { return_timestamps: true });
      chunks++;
      const segs = (r && r.chunks && r.chunks.length) ? r.chunks : (r && r.text ? [{ text: r.text, timestamp: [0, 0] }] : []);
      for (const s of segs) {
        const text = String(s.text || '').trim(); if (!text) continue;
        words += text.split(/\s+/).length;
        if (isGoalTalk(text)) hits.push({ t: start + ((s.timestamp && s.timestamp[0]) || 0), text, strong: isStrongGoalTalk(text) });
      }
    },
  });
  return { words, chunks, skipped, hits };
}
