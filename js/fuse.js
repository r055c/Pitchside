// Pitchside smart goal finder: merges every weak signal (scoreboard, ball + kick-off, crowd noise, cheering/whistle
// sound classifier, spoken "goal") into one ranked list. If the final score is known, the best N are picked.
// Pure functions, no browser needed.

export const SOURCES = {
  ball: { label: 'Ball in goal, then kick-off', rank: 0 },
  board: { label: 'Scoreboard changed', rank: 1 },
  geminiFine: { label: 'Gemini checked the exact moment', rank: 1.5 },
  ballMaybe: { label: 'Ball reached the goal', rank: 2 },
  speech: { label: 'Someone said "goal"', rank: 3 },
  cheer: { label: 'Cheering', rank: 4 },
  crowd: { label: 'Crowd roar', rank: 5 },
  gemini: { label: 'Gemini saw a goal', rank: 6 },   // watches the video, but its times are only roughly right
};

// events: [{ src, t, conf (0-1), side?, note? }]. Returns candidates sorted by time:
// [{ time, score, evidence: [{ src, label, conf }], side, picked }]
export function fuse(events, { n = null, window: win = 25, span = 45, threshold = 0.55 } = {}) {
  const ev = events.filter(e => e && isFinite(e.t) && e.conf > 0).map(e => ({ ...e })).sort((a, b) => a.t - b.t);
  const clusters = [];
  for (const e of ev) {
    const c = clusters[clusters.length - 1];
    if (c && e.t - c.last <= win && e.t - c.first <= span) { c.items.push(e); c.last = e.t; }
    else clusters.push({ items: [e], first: e.t, last: e.t });
  }
  const out = clusters.map(c => {
    const best = {}; // strongest event per source
    for (const e of c.items) if (!best[e.src] || e.conf > best[e.src].conf) best[e.src] = e;
    const list = Object.values(best).sort((a, b) => SOURCES[a.src].rank - SOURCES[b.src].rank);
    let miss = 1; for (const e of list) miss *= 1 - Math.min(0.97, e.conf);
    const lead = list[0]; // most trustworthy time stamp wins
    const withSide = list.find(e => e.side);
    return { time: lead.t, score: Math.round((1 - miss) * 100) / 100, side: withSide ? withSide.side : null,
             evidence: list.map(e => ({ src: e.src, label: e.note || SOURCES[e.src].label, conf: Math.round(e.conf * 100) / 100 })), picked: false };
  });
  const ranked = out.slice().sort((a, b) => b.score - a.score || a.time - b.time);
  const take = n != null ? ranked.slice(0, n) : ranked.filter(c => c.score >= threshold);
  take.forEach(c => { c.picked = true; });
  return out.sort((a, b) => a.time - b.time);
}

// ---- evidence from the sound classifier (YAMNet): series of 0-255 values, one per `hop` seconds ----
function smooth(a, k = 1) { return a.map((_, i) => { let s = 0, c = 0; for (let j = i - k; j <= i + k; j++) if (j >= 0 && j < a.length) { s += a[j]; c++; } return s / c; }); }
function pct(arr, p) { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] || 0; }

export function soundEvents(sound) {
  if (!sound || !sound.cheer || sound.cheer.length < 20) return [];
  const hop = sound.hop || 0.48, n = sound.cheer.length;
  const cheer = smooth(sound.cheer.map((v, i) => Math.max(v, sound.applause ? sound.applause[i] : 0, 0.5 * (sound.crowd ? sound.crowd[i] : 0)) / 255), 2);
  const whistle = smooth((sound.whistle || new Array(n).fill(0)).map(v => v / 255), 1);
  const floor = Math.max(0.2, pct(cheer, 92));
  const peaks = [];
  for (let i = 1; i < n - 1; i++) if (cheer[i] >= floor && cheer[i] >= cheer[i - 1] && cheer[i] > cheer[i + 1]) peaks.push(i);
  peaks.sort((a, b) => cheer[b] - cheer[a]);
  const kept = [];
  for (const p of peaks) if (kept.every(q => Math.abs(q - p) * hop >= 20)) kept.push(p);
  const out = [];
  for (const p of kept.sort((a, b) => a - b)) {
    let s = p; while (s > 0 && cheer[s - 1] > cheer[p] * 0.5 && (p - s) * hop < 15) s--;     // where the cheer starts
    let conf = Math.min(0.55, Math.max(0.2, 0.2 + 0.4 * (cheer[p] - 0.25) / 0.5));
    let note = 'Cheering';
    const w0 = Math.floor((s * hop + 15) / hop), w1 = Math.min(n - 1, Math.floor((s * hop + 100) / hop));
    let wmax = 0; for (let j = w0; j <= w1; j++) wmax = Math.max(wmax, whistle[j] || 0);
    if (wmax >= 0.3) { conf = Math.min(0.7, conf + 0.1); note = 'Cheering, then a whistle'; }
    out.push({ src: 'cheer', t: Math.max(0, s * hop - 1), conf, note });
  }
  return out;
}

// ---- evidence from speech: hits = [{ t, text, strong }] ----
export function speechEvents(speech) {
  if (!speech || !speech.hits) return [];
  return speech.hits.map(h => ({ src: 'speech', t: Math.max(0, h.t - 2), conf: h.strong ? 0.45 : 0.2, note: `Heard: "${String(h.text).slice(0, 40)}"` }));
}

// ---- evidence from Gemini: { goals: [{ t, side, conf, note }] } ----
export function geminiEvents(g) {
  if (!g || !g.goals) return [];
  return g.goals.map(x => {
    const c = x.conf == null ? 0.5 : x.conf;
    const o = x.unsure ? { src: 'gemini', conf: 0.3 } : x.fine ? { src: 'geminiFine', conf: Math.min(0.9, 0.75 + 0.15 * c) } : { src: 'gemini', conf: 0.5 + 0.2 * c };
    return { ...o, t: x.t, side: x.side || undefined, note: x.note ? 'Gemini: ' + x.note : undefined };
  });
}

export const GOAL_WORDS = [/\bgoal+s?\b/i, /\bscor(e|ed|es)\b/i, /\bget in\b/i, /\bwhat a (strike|finish|hit|goal)\b/i, /\bin the back of the net\b/i, /\bone[- ]nil\b|\btwo[- ]nil\b/i];
export function isGoalTalk(text) { return GOAL_WORDS.some(r => r.test(text)); }
export function isStrongGoalTalk(text) { return /\bgoal+s?\b|\bin the back of the net\b/i.test(text); }
