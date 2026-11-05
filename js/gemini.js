// Ask Gemini (beta): sends the match video to Google's Gemini with YOUR OWN free API key (from aistudio.google.com)
// and asks it to list the goals. Your browser talks to Google directly; the key is never sent anywhere else.
// Steps: list models -> upload the video (File API) -> ask in 15-minute parts -> delete the upload.

const API = 'https://generativelanguage.googleapis.com';

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Stopped.')); }, { once: true });
});

async function api(path, key, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(API + path, { method, signal, headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { if (e.name === 'AbortError') throw new Error('Stopped.'); throw new Error('Could not reach Google (' + (e.message || 'network error') + '). Check the internet connection, or whether this network blocks Google.'); }
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) { const err = new Error(friendly(res.status, json, text)); err.status = res.status; err.retryAfter = retryDelay(json); throw err; }
  return json;
}

function retryDelay(json) {
  try { const d = (json.error.details || []).find(x => x.retryDelay); if (d) return Math.min(120, Math.ceil(parseFloat(d.retryDelay))); } catch (_) {}
  return null;
}
function friendly(status, json, text) {
  const msg = (json && json.error && json.error.message) || String(text || '').slice(0, 200);
  if (status === 400 && /API key|API_KEY/i.test(msg)) return 'Google did not accept that key. Check you pasted all of it.';
  if (status === 401 || status === 403) return 'Google refused the request (' + status + '): ' + msg;
  if (status === 429) return 'Google’s free limit was reached: ' + msg.slice(0, 160);
  return 'Google said (' + status + '): ' + msg.slice(0, 240);
}

// ---- models: pick sensible video-capable ones ----
export async function listModels(key, { signal } = {}) {
  const out = []; let token = '';
  for (let i = 0; i < 5; i++) {
    const j = await api('/v1beta/models?pageSize=100' + (token ? '&pageToken=' + encodeURIComponent(token) : ''), key, { signal });
    for (const m of (j && j.models) || []) {
      const name = String(m.name || '').replace(/^models\//, '');
      if (!/^gemini/.test(name) || !(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      if (/image|tts|embed|live|audio|robotics|computer|lite|exp-|customtools|learnlm/i.test(name)) continue;
      out.push({ name, label: m.displayName || name });
    }
    token = j && j.nextPageToken; if (!token) break;
  }
  const ver = n => { const v = n.match(/gemini-(\d+(?:\.\d+)?)/); return v ? parseFloat(v[1]) : 0; };
  const score = n => (/flash/.test(n) ? 1000 : /pro/.test(n) ? 500 : 0) + ver(n) * 10 - (/preview|latest/.test(n) ? 60 : 0);
  out.sort((a, b) => score(b.name) - score(a.name));
  if (!out.length) throw new Error('That key works, but I could not find a Gemini model that can watch video on it.');
  return out;
}

// ---- upload (resumable) with progress ----
export async function uploadVideo(key, file, { onProgress = () => {}, signal } = {}) {
  const mime = file.type || (/\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4');
  let start;
  try {
    start = await fetch(API + '/upload/v1beta/files', {
      method: 'POST', signal,
      headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(file.size), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: { display_name: 'pitchside-match' } }),
    });
  } catch (e) { if (e.name === 'AbortError') throw new Error('Stopped.'); throw new Error('Could not start the upload to Google (' + (e.message || 'network error') + ').'); }
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
  // wait until Google has processed it
  let f = info;
  for (let i = 0; i < 150 && f.state && f.state !== 'ACTIVE'; i++) {
    if (f.state === 'FAILED') throw new Error('Google could not process this video file.');
    await sleep(4000, signal);
    f = await api('/v1beta/' + f.name, key, { signal });
  }
  if (f.state && f.state !== 'ACTIVE') throw new Error('Google is taking too long to process the video. Try again in a few minutes.');
  return { name: f.name, uri: f.uri, mimeType: f.mimeType || mime };
}

export async function deleteUpload(key, name) { try { await api('/v1beta/' + name, key, { method: 'DELETE' }); return true; } catch (_) { return false; } }

// ---- ask ----
export function parseClock(s) {
  const m = String(s == null ? '' : s).trim().match(/^(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.\d+)?$/) || null;
  if (m) return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3];
  const n = parseFloat(s); return isFinite(n) ? n : null;
}
const mmss = t => { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };

const SCHEMA = { type: 'OBJECT', properties: { goals: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
  time_in_video: { type: 'STRING' }, team: { type: 'STRING' }, confidence: { type: 'NUMBER' }, evidence: { type: 'STRING' } },
  required: ['time_in_video', 'team'] } } }, required: ['goals'] };

function prompt(us, them, a, b) {
  return `This is a video of a football (soccer) match between "${us}" and "${them}". You are looking at the part from ${mmss(a)} to ${mmss(b)} of the video. ` +
    `List every goal that is actually scored in this part (not shots that are saved, missed or blocked, and not goals that are disallowed). ` +
    `For each goal give: time_in_video = the moment the ball crosses the line, as mm:ss on the video's own timeline counted from the very start of the whole video (NOT the match clock); ` +
    `team = exactly "${us}" or "${them}" for the team that scored; confidence from 0 to 1; evidence = a few words (for example "scoreboard changed to 2-1, players celebrating"). ` +
    `Use the scoreboard, the celebrations, the restart from the centre circle and the commentary or crowd noise. If you are not sure there was a goal, leave it out. If there are no goals, return an empty list.`;
}

// Returns { goals: [{ t, team, conf, note }], parts: n }. onProgress({ part, parts, text }).
export async function askGoals(key, model, file, { us, them, duration, partSeconds = 900, onProgress = () => {}, signal } = {}) {
  const parts = []; for (let a = 0; a < duration; a += partSeconds) parts.push([a, Math.min(duration, a + partSeconds)]);
  const goals = [];
  for (let i = 0; i < parts.length; i++) {
    const [a, b] = parts[i];
    onProgress({ part: i + 1, parts: parts.length, text: `Asking Gemini about ${mmss(a)}–${mmss(b)} (part ${i + 1} of ${parts.length})…` });
    const body = { contents: [{ parts: [{ fileData: { mimeType: file.mimeType, fileUri: file.uri }, videoMetadata: { startOffset: Math.floor(a) + 's', endOffset: Math.ceil(b) + 's' } }, { text: prompt(us, them, a, b) }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA, mediaResolution: 'MEDIA_RESOLUTION_LOW' } };
    let j = null;
    for (let tryN = 0; tryN < 6; tryN++) {
      try { j = await api(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, key, { method: 'POST', body, signal }); break; }
      catch (e) {
        if (e.status === 429 && tryN < 5) { const w = e.retryAfter || 45; for (let s = w; s > 0; s--) { onProgress({ part: i + 1, parts: parts.length, text: `Google’s free limit reached, waiting ${s}s then carrying on (part ${i + 1} of ${parts.length})…` }); await sleep(1000, signal); } continue; }
        if (e.status >= 500 && tryN < 3) { await sleep(5000, signal); continue; }
        throw e;
      }
    }
    const text = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts.map(p => p.text || '').join('');
    let list = []; try { list = (JSON.parse(text || '{}').goals) || []; } catch (_) {
      const fin = j && j.candidates && j.candidates[0] && j.candidates[0].finishReason; if (fin && fin !== 'STOP') throw new Error('Gemini did not answer this part (' + fin + ').'); }
    const found = list.map(g => ({ t: parseClock(g.time_in_video), team: String(g.team || ''), conf: Math.max(0, Math.min(1, +g.confidence || 0.5)), note: String(g.evidence || '').slice(0, 70) })).filter(g => g.t != null);
    // some answers count from the start of the clip instead of the whole video; fix those
    if (a > 600 && found.length && found.every(g => g.t < a - 20)) found.forEach(g => { g.t += a; });
    for (const g of found) if (g.t >= a - 30 && g.t <= b + 30) goals.push(g);
  }
  goals.sort((x, y) => x.t - y.t);
  return { goals, parts: parts.length };
}
