// Ask Gemini (beta): the AI watches the match video and lists goals (and, optionally, shots, saves, corners, fouls).
// Pipeline: upload the video once -> pass 1 in 15-minute parts (with the score after each goal) -> look for goals the
// score says are missing -> take a closer look at each goal for the exact second -> delete the upload.
//
// Where the key lives (auth):
//   • a string                      = the user's own key, sent from the browser straight to Google (works anywhere)
//   • { proxy: '/api/gemini', pass } = a same-origin proxy (see worker/gemini-proxy.js for Cloudflare). The key is a
//                                      server secret and never reaches the browser. The proxy only ever sees small
//                                      requests: the big video upload goes from the browser straight to Google on a
//                                      pre-authorised upload address.

const API = 'https://generativelanguage.googleapis.com';

const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal && signal.aborted) return rej(new Error('Stopped.'));
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Stopped.')); }, { once: true });
});

const norm = auth => (typeof auth === 'string' ? { key: auth } : (auth || {}));
const baseOf = A => (A.proxy ? String(A.proxy).replace(/\/$/, '') : API);
const authHeaders = A => ({ ...(A.key ? { 'x-goog-api-key': A.key } : {}), ...(A.pass ? { 'X-Pitchside-Pass': A.pass } : {}) });

async function api(auth, path, { method = 'GET', body, signal, timeoutMs } = {}) {
  const A = norm(auth);
  let res, timedOut = false, timer = null;
  const ac = new AbortController();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true }); }
  if (timeoutMs) timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const slow = () => { const er = new Error('Gemini took too long to answer.'); er.timeout = true; return er; };
  try {
    res = await fetch(baseOf(A) + path, { method, signal: ac.signal, headers: { ...authHeaders(A), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    if (timedOut) throw slow();
    if (e.name === 'AbortError') throw new Error('Stopped.');
    throw new Error('Could not reach ' + (A.proxy ? 'the server' : 'Google') + ' (' + (e.message || 'network error') + '). Check the internet connection, or whether this network blocks it.');
  } finally { if (timer) clearTimeout(timer); }
  let text; try { text = await res.text(); } catch (e) { if (timedOut) throw slow(); throw e; }
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) { const err = new Error(friendly(res.status, json, text)); err.status = res.status; err.retryAfter = retryDelay(json); err.daily = res.status === 429 && /PerDay|per day|daily/i.test(text || ''); throw err; }
  return json;
}

function retryDelay(json) {
  try { const d = (json.error.details || []).find(x => x.retryDelay); if (d) return Math.min(120, Math.ceil(parseFloat(d.retryDelay))); } catch (_) {}
  return null;
}
function friendly(status, json, text) {
  const msg = (json && json.error && (json.error.message || json.error)) || String(text || '').slice(0, 200);
  if (status === 400 && /API key|API_KEY/i.test(String(msg))) return 'Google did not accept that key. Check you pasted all of it.';
  if (status === 401) return 'Not allowed: ' + String(msg).slice(0, 160);
  if (status === 403) return 'Refused (403): ' + String(msg).slice(0, 200);
  if (status === 429) return 'Google’s free limit was reached: ' + String(msg).slice(0, 160);
  return 'Google said (' + status + '): ' + String(msg).slice(0, 240);
}

// ---- models ----
export async function listModels(auth, { signal } = {}) {
  const out = [], all = []; let token = '';
  for (let i = 0; i < 5; i++) {
    const j = await api(auth, '/v1beta/models?pageSize=100' + (token ? '&pageToken=' + encodeURIComponent(token) : ''), { signal });
    for (const m of (j && j.models) || []) {
      const name = String(m.name || '').replace(/^models\//, '');
      if (!/^gemini/.test(name) || !(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      if (/image|tts|embed|live|audio|robotics|computer|exp-|customtools|learnlm|omni|nano|banana|transcribe|translate/i.test(name)) continue;
      all.push({ name, label: m.displayName || name });
      if (!/flash/i.test(name) || /preview|latest|pro|argon/i.test(name)) continue;   // plain Flash and Flash-Lite only: the ones worth cycling through
      out.push({ name, label: m.displayName || name });
    }
    token = j && j.nextPageToken; if (!token) break;
  }
  const ver = n => { const v = n.match(/gemini-(\d+(?:\.\d+)?)/); return v ? parseFloat(v[1]) : 0; };
  const score = n => (/flash/.test(n) ? 1000 : /pro/.test(n) ? 500 : 0) + ver(n) * 10 - (/preview|latest/.test(n) ? 60 : 0) - (/lite/.test(n) ? 5 : 0);
  if (!out.length) out.push(...all);   // nothing plain-Flash on this key: fall back to anything that can watch video
  out.sort((a, b) => score(b.name) - score(a.name));
  if (!out.length) throw new Error('That works, but I could not find a Gemini model that can watch video on it.');
  return out;
}


// ---- cycling through models when one is busy, out of free requests or gone ----
const COOL_KEY = 'ps_gemini_cool';
const readCool = () => { try { return JSON.parse(localStorage.getItem(COOL_KEY) || '{}') || {}; } catch (_) { return {}; } };
const writeCool = o => { try { localStorage.setItem(COOL_KEY, JSON.stringify(o)); } catch (_) {} };
function msToPacificMidnight() {   // free daily limits reset at midnight US Pacific time (08:00 in the UK in winter)
  try { const la = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })); return Math.max(60000, 86400000 - ((la.getHours() * 60 + la.getMinutes()) * 60 + la.getSeconds()) * 1000); } catch (_) { return 6 * 3600000; }
}
export function classifyError(e) {
  if (!e || e.name === 'AbortError') return null;
  if (e.status === 404 || /no longer available|is not found|not supported for generateContent/i.test(e.message || '')) return 'gone';
  if (e.status === 429) return e.daily ? 'daily' : 'rate';
  if (e.status >= 500 || e.busy || /overloaded|high demand|unavailable/i.test(e.message || '')) return 'busy';
  return null;
}
export function restingModels() {
  const c = readCool(), now = Date.now(), out = [];
  for (const [name, v] of Object.entries(c)) if (v && v.until > now) out.push({ name, kind: v.kind, until: v.until });
  return out;
}
const rest = (name, kind) => {
  const c = readCool(); const ms = { daily: msToPacificMidnight(), busy: 10 * 60000, rate: 2 * 60000, gone: 7 * 86400000 }[kind] || 600000;
  c[name] = { kind, until: Date.now() + ms }; writeCool(c);
};
export const KIND_TEXT = { daily: 'out of free requests for today', busy: 'too busy', rate: 'at its per-minute limit', gone: 'no longer available' };
// run(modelName) is tried on each model in turn. A real error (bad key, bad video) stops straight away.
export async function withModels(names, run, { signal, onSwitch = () => {} } = {}) {
  const resting = new Set(restingModels().map(x => x.name));
  let list = names.filter(n => !resting.has(n));
  if (!list.length) list = names.slice();       // everything is resting: try anyway, a reset may have happened
  let last = null; const log = [];
  for (const name of list) {
    try { return { model: name, result: await run(name) }; }
    catch (e) {
      if (signal && signal.aborted) throw e;
      const kind = classifyError(e); if (!kind) throw e;
      rest(name, kind); last = e; log.push(`${name}: ${KIND_TEXT[kind]}`);
      onSwitch(name, kind, list[list.indexOf(name) + 1] || null);
    }
  }
  const err = new Error(`Every model is busy or out of free requests right now (${log.join('; ')}). Try again later. Daily limits reset at 08:00 UK time.`);
  err.status = last && last.status; err.allFailed = true; throw err;
}

// ---- upload (resumable) with progress ----
export async function uploadVideo(auth, file, { onProgress = () => {}, signal } = {}) {
  const A = norm(auth);
  const mime = file.type || (/\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4');
  let start;
  try {
    start = await fetch(baseOf(A) + '/upload/v1beta/files', {
      method: 'POST', signal,
      headers: { ...authHeaders(A), 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(file.size), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: { display_name: 'pitchside-match' } }),
    });
  } catch (e) { if (e.name === 'AbortError') throw new Error('Stopped.'); throw new Error('Could not start the upload (' + (e.message || 'network error') + ').'); }
  if (!start.ok) { let j = null, t = ''; try { t = await start.text(); j = JSON.parse(t); } catch (_) {} throw new Error(friendly(start.status, j, t)); }
  const url = start.headers.get('x-goog-upload-url');
  if (!url) throw new Error('Google did not return an upload address (the browser may be hiding it). Try Chrome or Edge.');
  const info = await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('POST', url);
    x.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize'); x.setRequestHeader('X-Goog-Upload-Offset', '0');
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => { try { const j = JSON.parse(x.responseText); if (x.status >= 200 && x.status < 300 && j.file) resolve(j.file); else reject(new Error(friendly(x.status, j, x.responseText))); } catch (e) { reject(new Error('Upload to Google failed (' + x.status + ').')); } };
    x.onerror = () => reject(new Error('The upload to Google was interrupted. Check the connection and try again.'));
    x.onabort = () => reject(new Error('Stopped.'));
    if (signal) signal.addEventListener('abort', () => x.abort(), { once: true });
    x.send(file);
  });
  let f = info;
  for (let i = 0; i < 150 && f.state && f.state !== 'ACTIVE'; i++) {
    if (f.state === 'FAILED') throw new Error('Google could not process this video file.');
    await sleep(4000, signal);
    f = await api(auth, '/v1beta/' + f.name, { signal });
  }
  if (f.state && f.state !== 'ACTIVE') throw new Error('Google is taking too long to process the video. Try again in a few minutes.');
  return { name: f.name, uri: f.uri, mimeType: f.mimeType || mime };
}
export async function deleteUpload(auth, name) { try { await api(auth, '/v1beta/' + name, { method: 'DELETE' }); return true; } catch (_) { return false; } }

// ---- small helpers ----
export function parseClock(s) {
  const m = String(s == null ? '' : s).trim().match(/^(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.\d+)?$/) || null;
  if (m) return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3] + (/\.(\d+)$/.test(String(s).trim()) ? parseFloat('0.' + String(s).trim().split('.').pop()) : 0);
  const n = parseFloat(s); return isFinite(n) ? n : null;
}
export const gmmss = t => { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const num = v => (v == null || v === '' || !isFinite(+v) ? null : Math.round(+v));
const T = { OBJ: 'OBJECT', ARR: 'ARRAY', STR: 'STRING', NUM: 'NUMBER', BOOL: 'BOOLEAN' };

// ---- one question to Gemini about one stretch of the video (timeouts, rate limits and retries handled) ----
async function ask(auth, model, file, { a, b, fps, res, text, schema }, { signal, onProgress = () => {}, label = '' } = {}) {
  const meta = { startOffset: Math.floor(a) + 's', endOffset: Math.ceil(b) + 's', ...(fps ? { fps } : {}) };
  const body = { contents: [{ parts: [{ fileData: { mimeType: file.mimeType, fileUri: file.uri }, videoMetadata: meta }, { text }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema, ...(res ? { mediaResolution: res } : {}) } };
  let j = null, timeouts = 0;
  for (let tryN = 0; tryN < 8; tryN++) {
    const t0 = Date.now();
    const tick = setInterval(() => onProgress(`${label} ${Math.round((Date.now() - t0) / 1000)}s` + (timeouts ? ` (retry ${timeouts})` : '')), 1000);
    try { j = await api(auth, `/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', body, signal, timeoutMs: 240000 }); break; }
    catch (e) {
      if (e.timeout && timeouts < 2) { timeouts++; continue; }
      if (e.timeout) { const te = new Error('Gemini did not answer (' + label.trim() + ') after three tries of 4 minutes each.'); te.busy = true; throw te; }
      if (e.status === 429 && !e.daily && tryN < 2) { const w = e.retryAfter || 45; for (let s = w; s > 0; s--) { onProgress(`Google’s free limit reached, waiting ${s}s then carrying on (${label.trim()})…`); await sleep(1000, signal); } continue; }
      if (e.status >= 500 && tryN < 3) { await sleep(5000, signal); continue; }
      throw e;
    } finally { clearInterval(tick); }
  }
  const cand = j && j.candidates && j.candidates[0];
  const out = cand && cand.content && cand.content.parts && cand.content.parts.map(p => p.text || '').join('');
  try { return JSON.parse(out || '{}'); }
  catch (_) { if (cand && cand.finishReason && cand.finishReason !== 'STOP') throw new Error('Gemini did not answer (' + cand.finishReason + ').'); return {}; }
}

// ================= goals =================
const GOAL_SCHEMA = { type: T.OBJ, properties: { goals: { type: T.ARR, items: { type: T.OBJ, properties: {
  time_in_video: { type: T.STR }, team: { type: T.STR }, score_a: { type: T.NUM }, score_b: { type: T.NUM }, confidence: { type: T.NUM }, evidence: { type: T.STR } },
  required: ['time_in_video', 'team'] } } }, required: ['goals'] };

const intro = (us, them, a, b) => `This is a video of a football (soccer) match between "${us}" and "${them}". You are looking at the part from ${gmmss(a)} to ${gmmss(b)} of the video. `;
const fields = (us, them) => `For each goal give: time_in_video = the moment the ball crosses the line, as mm:ss on the video's own timeline counted from the very start of the whole video (NOT the match clock); ` +
  `team = exactly "${us}" or "${them}" for the team that scored; score_a = goals by "${us}" after this goal and score_b = goals by "${them}" after this goal (read the scoreboard if you can see it, otherwise count); ` +
  `confidence from 0 to 1; evidence = a few words (for example "scoreboard changed to 2-1, players celebrating").`;
const how = `Use the scoreboard, the celebrations, the restart from the centre circle and the commentary or crowd noise. If you are not sure there was a goal, leave it out. If there are none, return an empty list.`;

function toGoals(list, a, b, sideOf, extra = {}) {
  let found = (list || []).map(g => ({ t: parseClock(g.time_in_video), team: String(g.team || ''), side: sideOf(String(g.team || '')), sa: num(g.score_a), sb: num(g.score_b),
    conf: Math.max(0, Math.min(1, +g.confidence || 0.5)), note: String(g.evidence || '').slice(0, 70), ...extra })).filter(g => g.t != null);
  if (a > 600 && found.length && found.every(g => g.t < a - 20)) found.forEach(g => { g.t += a; });   // answered from the clip start, not the video start
  return found.filter(g => g.t >= a - 30 && g.t <= b + 30);
}

function dedupe(goals, within = 25) {
  const s = goals.slice().sort((x, y) => x.t - y.t), out = [];
  for (const g of s) { const l = out[out.length - 1]; if (l && g.t - l.t < within) { if (g.conf > l.conf) out[out.length - 1] = { ...g, sa: g.sa ?? l.sa, sb: g.sb ?? l.sb }; } else out.push(g); }
  return out;
}

// windows where the score (or the final score) says goals are missing
export function findGaps(goals, { duration, finalUs, finalThem }) {
  const gaps = []; let pa = 0, pb = 0, pt = 0, haveScore = false;
  for (const g of goals) {
    if (g.sa != null && g.sb != null && g.sa >= pa && g.sb >= pb) {
      haveScore = true; const jump = (g.sa + g.sb) - (pa + pb);
      if (jump > 1) gaps.push({ a: pt, b: g.t, missing: jump - 1, why: `score went from ${pa}–${pb} to ${g.sa}–${g.sb}` });
      pa = g.sa; pb = g.sb; pt = g.t;
    } else pt = g.t;
  }
  const known = finalUs != null && finalThem != null ? finalUs + finalThem : null;
  if (known != null) {
    const have = haveScore ? pa + pb : goals.length;
    if (known > have) {
      if (haveScore || !goals.length) gaps.push({ a: pt, b: duration, missing: known - have, why: `the final score is ${finalUs}–${finalThem}` });
      else gaps.push({ a: 0, b: duration, missing: known - have, why: `the final score is ${finalUs}–${finalThem}`, wide: true });
    }
  }
  return gaps;
}

// Returns { goals: [{ t, side, team, conf, note, fine?, unsure?, gap?, sa, sb }], warnings: [] }
export async function geminiGoals(auth, model, file, { us, them, duration, finalUs = null, finalThem = null, sideOf = () => null, refine = true, partSeconds = 900, onProgress = () => {}, signal } = {}) {
  const warnings = []; let goals = [];
  const parts = []; for (let a = 0; a < duration; a += partSeconds) parts.push([a, Math.min(duration, a + partSeconds)]);
  for (let i = 0; i < parts.length; i++) {
    const [a, b] = parts[i];
    const r = await ask(auth, model, file, { a, b, res: 'MEDIA_RESOLUTION_LOW', schema: GOAL_SCHEMA,
      text: intro(us, them, a, b) + `List every goal that is actually scored in this part (not shots that are saved, missed or blocked, and not goals that are disallowed). ` + fields(us, them) + ' ' + how },
      { signal, onProgress, label: `Step 1: Gemini is watching ${gmmss(a)}–${gmmss(b)} (part ${i + 1} of ${parts.length})…` });
    goals.push(...toGoals(r.goals, a, b, sideOf));
  }
  goals = dedupe(goals);
  onProgress(`Step 1 found ${goals.length} goal${goals.length === 1 ? '' : 's'}.`);

  // step 2: goals the score says are missing
  const gaps = findGaps(goals, { duration, finalUs, finalThem }).slice(0, 5);
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i]; let spans = [];
    if (g.wide || g.b - g.a > 1500) { for (let a = g.a; a < g.b; a += 450) spans.push([a, Math.min(g.b, a + 450)]); } else spans = [[g.a, g.b]];
    let got = 0;
    for (let k = 0; k < spans.length; k++) {
      const [a, b] = spans[k];
      const r = await ask(auth, model, file, { a, b, fps: 2, schema: GOAL_SCHEMA,
        text: intro(us, them, a, b) + `A first look found no goal here, but ${g.why}, so about ${g.missing} goal${g.missing === 1 ? ' was' : 's were'} probably missed in the stretch ${gmmss(g.a)}–${gmmss(g.b)}. Look carefully for it${g.missing === 1 ? '' : ' or them'}: a ball in the net, a celebration, a restart from the centre circle. ` + fields(us, them) + ' ' + how },
        { signal, onProgress, label: `Step 2: second look at ${gmmss(a)}–${gmmss(b)} (${g.why})…` });
      const add = toGoals(r.goals, a, b, sideOf, { gap: true }).filter(x => goals.every(y => Math.abs(y.t - x.t) > 25));
      goals.push(...add); got += add.length; if (got >= g.missing) break;
    }
    if (got < g.missing) warnings.push(`Still missing ${g.missing - got} goal${g.missing - got === 1 ? '' : 's'}: ${g.why}.`);
  }
  goals = dedupe(goals);

  // step 3: closer look at each goal for the exact second
  if (refine) {
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i], a = Math.max(0, g.t - 40), b = Math.min(duration, g.t + 35);
      onProgress(`Step 3: closer look at goal ${i + 1} of ${goals.length} (${gmmss(g.t)})…`);
      try {
        const r = await ask(auth, model, file, { a, b, fps: 2, schema: { type: T.OBJ, properties: { goal_confirmed: { type: T.BOOL }, time_in_video: { type: T.STR }, team: { type: T.STR }, score_a: { type: T.NUM }, score_b: { type: T.NUM }, evidence: { type: T.STR } }, required: ['goal_confirmed'] },
          text: intro(us, them, a, b) + `Is a goal scored in this clip? If yes, give time_in_video = the exact moment the ball fully crosses the goal line, as mm:ss on the video's own timeline counted from the very start of the whole video (NOT the match clock), team = exactly "${us}" or "${them}" for the team that scored, ` +
            `score_a / score_b = goals by "${us}" / "${them}" after it, and evidence = a few words. If the ball is saved, missed, blocked or the goal is disallowed, set goal_confirmed to false.` },
          { signal, onProgress, label: `Step 3: closer look at goal ${i + 1} of ${goals.length}…` });
        if (r.goal_confirmed) {
          let t = parseClock(r.time_in_video); if (t != null && a > 600 && t < a - 20) t += a;
          if (t != null && t >= a - 5 && t <= b + 5) { g.t = t; g.fine = true; }
          const side = sideOf(String(r.team || '')); if (side && g.side && side !== g.side) { warnings.push(`At ${gmmss(g.t)} the closer look says ${r.team} scored; the first look said ${g.team}. Please check it.`); g.side = side; g.team = r.team; }
          if (side && !g.side) { g.side = side; g.team = r.team; }
          const sa = num(r.score_a), sb = num(r.score_b); if (sa != null && sb != null) { g.sa = sa; g.sb = sb; }
          if (r.evidence) g.note = String(r.evidence).slice(0, 70);
        } else { g.unsure = true; g.conf *= 0.5; g.note = (g.note ? g.note + ' ' : '') + '(not confirmed on a closer look)'; warnings.push(`The goal at ${gmmss(g.t)} was not confirmed on a closer look.`); }
      } catch (e) { if (e.message === 'Stopped.') throw e; warnings.push(`Could not take a closer look at ${gmmss(g.t)}: ${e.message}`); }
    }
    goals = dedupe(goals, 15);
  }

  // checks against the final score
  const us1 = goals.filter(g => g.side === 'us').length, them1 = goals.filter(g => g.side === 'them').length, unk = goals.filter(g => !g.side).length;
  if (finalUs != null && finalThem != null) {
    if (goals.length !== finalUs + finalThem) warnings.push(`Gemini found ${goals.length} goals, but the final score ${finalUs}–${finalThem} means ${finalUs + finalThem}.`);
    else if (!unk && (us1 !== finalUs || them1 !== finalThem)) warnings.push(`The right number of goals, but split ${us1}–${them1} instead of ${finalUs}–${finalThem}. Check who scored.`);
  }
  return { goals, warnings };
}

// ================= other moments (shots, saves, corners, fouls) =================
const MOMENT_TYPES = { shot_on_target: 'sot', shot_off_target: 'off', corner: 'corner', save: 'save', foul: 'foul', yellow_card: 'yellow', red_card: 'red', highlight: 'highlight' };
export async function geminiMoments(auth, model, file, { us, them, duration, sideOf = () => null, partSeconds = 600, onProgress = () => {}, signal } = {}) {
  const schema = { type: T.OBJ, properties: { moments: { type: T.ARR, items: { type: T.OBJ, properties: { time_in_video: { type: T.STR }, kind: { type: T.STR }, team: { type: T.STR }, evidence: { type: T.STR }, confidence: { type: T.NUM } }, required: ['time_in_video', 'kind', 'team'] } } }, required: ['moments'] };
  const out = [];
  const parts = []; for (let a = 0; a < duration; a += partSeconds) parts.push([a, Math.min(duration, a + partSeconds)]);
  for (let i = 0; i < parts.length; i++) {
    const [a, b] = parts[i];
    const r = await ask(auth, model, file, { a, b, fps: 2, res: 'MEDIA_RESOLUTION_LOW', schema,
      text: intro(us, them, a, b) + `List the notable moments in this part, ignoring goals. Each has kind = one of: ` +
        `shot_on_target (a player deliberately strikes or heads the ball at goal and it is saved or would have gone in), ` +
        `shot_off_target (a deliberate attempt to score that misses or is blocked), corner (a corner kick is awarded), save (the goalkeeper stops a shot), foul (a foul is given), ` +
        `yellow_card or red_card (the referee shows that card), highlight (a good chance, near miss, great move or other moment worth watching that is NOT a shot). ` +
        `A shot is ONLY a clear attempt to score. Crosses, passes, clearances, throw-ins, dribbles and balls that merely go near the goal are NOT shots. If you are not sure it was an attempt to score, use highlight. ` +
        `time_in_video = mm:ss on the video's own timeline counted from the very start of the whole video (NOT the match clock). team = exactly "${us}" or "${them}": the team that took the shot, won the corner, committed the foul, was shown the card, made the move, or whose goalkeeper made the save. ` +
        `confidence = 0 to 1 for how sure you are of the kind. evidence = a few words. Only include what you clearly see.` },
      { signal, onProgress, label: `Looking for shots, saves, corners and fouls in ${gmmss(a)}–${gmmss(b)} (part ${i + 1} of ${parts.length})…` });
    let found = (r.moments || []).map(x => { const c = typeof x.confidence === 'number' ? x.confidence : 0.7; let type = MOMENT_TYPES[String(x.kind || '').trim()]; if (type && type !== 'highlight' && type !== 'red' && type !== 'yellow' && c < 0.6) type = 'highlight'; return { t: parseClock(x.time_in_video), type, side: sideOf(String(x.team || '')), note: String(x.evidence || '').slice(0, 60), conf: c }; }).filter(x => x.t != null && x.type);
    if (a > 600 && found.length && found.every(g => g.t < a - 20)) found.forEach(g => { g.t += a; });
    out.push(...found.filter(g => g.t >= a - 10 && g.t <= b + 10));
  }
  out.sort((x, y) => x.t - y.t);
  return out.filter((g, i) => !out.slice(0, i).some(h => h.type === g.type && h.side === g.side && Math.abs(h.t - g.t) < 6));
}
