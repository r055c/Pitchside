import * as DB from './db.js';
import { scanVideo, probeVideo, processSignals, findGoals, findScoreChanges, snapToRoar, trainGoalModel } from './analysis.js';
import { makeHighlightsVideo, pickMime } from './export.js';
import { loadBallSession, scanBall, hasWebGPU, cleanTrack, suggestZones, findCandidates } from './ball.js';
import { fuse, soundEvents, speechEvents, geminiEvents, SOURCES } from './fuse.js';
import { listModels, uploadVideo, deleteUpload, askGoals } from './gemini.js';
import { loadYamnet, scanSound, getYamnetBuffer, keepYamnet } from './sound.js';
import { loadWhisper, scanSpeech } from './speech.js';
import { audioSupported } from './audio.js';

// ============================================================ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = sec => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const fmtDate = d => { try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return ''; } };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const app = $('#app');
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

// ============================================================ state
const S = { file: null, fileUrl: null, fileFor: null, rate: 4, ballFps: 2, ball: { name: null, buffer: null, sess: null }, scanning: null, reel: null, clipEnd: null, clipId: null, tick: null, ourSeek: false, pendingPlay: null };
const haveFile = m => S.file && S.fileFor === m.id;
function setFile(m, file) {
  if (S.fileUrl) URL.revokeObjectURL(S.fileUrl);
  S.file = file; S.fileUrl = URL.createObjectURL(file); S.fileFor = m.id;
}
function unmount() {
  clearInterval(S.tick); S.tick = null; S.reel = null; S.clipEnd = null; S.clipId = null;
}

// ============================================================ tagging model
const TYPES = {
  goal: { label: 'Goal', ch: 'G' },
  sot: { label: 'Shot on target', ch: 'S' },
  off: { label: 'Shot off target', ch: 'S', hollow: true },
  corner: { label: 'Corner won', ch: 'C' },
  save: { label: 'Save by keeper', ch: 'K' },
  foul: { label: 'Foul committed', ch: 'F' },
};
function stats(m) {
  const z = () => ({ goals: 0, shots: 0, sot: 0, corners: 0, saves: 0, fouls: 0 });
  const r = { us: z(), them: z() };
  for (const e of m.events || []) {
    if (!e.type || e.type === 'skip' || !e.side) continue;
    const a = r[e.side], b = r[e.side === 'us' ? 'them' : 'us'];
    if (e.type === 'goal') { a.goals++; a.shots++; a.sot++; }
    else if (e.type === 'sot') { a.shots++; a.sot++; }
    else if (e.type === 'off') a.shots++;
    else if (e.type === 'corner') a.corners++;
    else if (e.type === 'save') { a.saves++; b.shots++; b.sot++; }   // a save implies a shot on target by the other side
    else if (e.type === 'foul') a.fouls++;
  }
  return r;
}
const taggedCount = m => (m.events || []).filter(e => e.type && e.type !== 'skip').length;

// ============================================================ shared UI bits
function topBar(title, sub, { back = '#/', menu = false } = {}) {
  return `<header class="top">
    <a class="back" href="${back}" aria-label="Back">&#8249;</a>
    <div class="ttl"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    ${menu ? '<button class="icon" id="menuBtn" aria-label="More options">&#8943;</button>' : '<span class="icon-space"></span>'}
  </header>`;
}
function sheet(title, items) {
  const s = document.createElement('div');
  s.className = 'scrim';
  s.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}"><h4>${esc(title)}</h4>
    ${items.map((it, i) => `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('')}
    <button data-i="x" class="cancel">Cancel</button></div>`;
  s.onclick = ev => {
    const b = ev.target.closest('button');
    if (ev.target === s || (b && b.dataset.i === 'x')) return s.remove();
    if (b) { s.remove(); items[+b.dataset.i].fn(); }
  };
  document.body.appendChild(s);
}
function wireMenu(m) {
  const b = $('#menuBtn'); if (!b) return;
  b.onclick = () => sheet(`${m.us} v ${m.them}`, [
    ...(m.events ? [{ label: 'Download match data (.csv)', fn: () => downloadMatchData(m) }] : []),
    ...(m.events ? [{ label: 'Export match data (.json)', fn: () => exportMatch(m) }, { label: 'Copy match data (if export is blocked)', fn: () => copyMatch(m) }] : []),
    ...(m.events && haveFile(m) ? [{ label: 'Scan again', fn: () => { m.events = null; m.curves = null; m.raw = null; DB.saveMatch(m).then(() => go(`#/match/${m.id}`)); } }] : []),
    { label: 'Delete this match', danger: true, fn: async () => { if (confirm('Delete this match and its tags from this device?')) { await DB.deleteMatch(m.id); toast('Match deleted'); go('#/'); } } },
  ]);
}
function matchCsv(m) {
  const q = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const row = (...c) => c.map(q).join(',');
  const st = stats(m), g = goalsOf(m);
  const out = [row('Match', `${m.us} v ${m.them}`), row('Date', m.date || ''),
    row('Score (from tagged goals)', `${st.us.goals}-${st.them.goals}`), '', row('Stat', m.us, m.them),
    row('Goals', st.us.goals, st.them.goals), row('Shots', st.us.shots, st.them.shots), row('Shots on target', st.us.sot, st.them.sot),
    row('Corners', st.us.corners, st.them.corners), row('Saves', st.us.saves, st.them.saves), row('Fouls', st.us.fouls, st.them.fouls), '',
    row('Video time', 'Event', 'Team', 'Score after')];
  const ev = (m.events || []).filter(e => e.type && e.type !== 'skip').sort((a, b) => a.time - b.time);
  for (const e of ev) {
    const sc = e.type === 'goal' && e.side ? (() => { const r = scoreAt(m, e.time, true); return `${r.us}-${r.them}`; })() : '';
    out.push(row(clock(e.time), TYPES[e.type] ? TYPES[e.type].label : e.type, e.side ? (e.side === 'us' ? m.us : m.them) : '', sc));
  }
  return '\uFEFF' + out.join('\r\n') + '\r\n';
}
function downloadMatchData(m) {
  const blob = new Blob([matchCsv(m)], { type: 'text/csv;charset=utf-8' });
  const name = `${slug(m.us)}-v-${slug(m.them)}-match-data.csv`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 4000);
  toast(`Saved ${name} to your Downloads`);
}
async function exportMatch(m) {
  const text = JSON.stringify(m);
  const blob = new Blob([text], { type: 'application/json' });
  const name = `${slug(m.us)}-v-${slug(m.them)}.json`;
  const f = new File([blob], name, { type: 'application/json' });
  // share sheet only on phones/tablets; laptops download directly
  const touch = navigator.maxTouchPoints > 1 && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (touch && navigator.canShare && navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f], title: 'Pitchside match' }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 4000);
  toast(`Saved ${name} to your Downloads`);
}
async function copyMatch(m) {
  const text = JSON.stringify(m);
  try { await navigator.clipboard.writeText(text); toast('Match data copied. Paste it into a text file or message.'); }
  catch (_) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (__) {}
    ta.remove(); toast(ok ? 'Match data copied. Paste it into a text file or message.' : 'Could not copy. Try Export instead.');
  }
}
function seg(id, opts, cur) {
  return `<div class="seg" id="${id}" role="group">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function wireSeg(id, fn) {
  const g = $('#' + id); if (!g) return;
  g.onclick = ev => { const b = ev.target.closest('button'); if (!b) return; $$('button', g).forEach(x => x.classList.toggle('on', x === b)); fn(b.dataset.v); };
}

// ============================================================ routes
async function route() {
  unmount();
  window.scrollTo(0, 0);
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
  if (!parts.length) return home();
  if (parts[0] === 'new') return newMatch();
  if (parts[0] === 'help') return help();
  if (parts[0] === 'match' && parts[1]) return matchView(parts[1], parts[2] || 'summary');
  return home();
}
window.addEventListener('hashchange', route);

// ============================================================ home
async function home() {
  const ms = await DB.allMatches();
  const cards = ms.map(m => {
    const st = stats(m), tagged = taggedCount(m);
    const score = tagged && (st.us.goals || st.them.goals || tagged > 0)
      ? `<span class="sc"><b class="us">${st.us.goals}</b><i>–</i><b class="them">${st.them.goals}</b></span>` : `<span class="sc dim">${m.events ? 'Not tagged yet' : 'Not scanned'}</span>`;
    return `<a class="match" href="#/match/${m.id}">
      <div><b>${esc(m.us)}</b><span class="v">v</span><b>${esc(m.them)}</b><small>${fmtDate(m.date)}${m.events ? ` · ${m.events.filter(e => e.type !== 'skip').length} moments` : ''}</small></div>${score}</a>`;
  }).join('');
  app.innerHTML = `<header class="top home"><div class="brand"><span class="mark"></span><b>Pitchside</b></div><a class="icon" href="#/help" aria-label="How it works">?</a></header>
  <main class="stack">
    ${ms.length ? `<h2 class="eyebrow">Your matches</h2><div class="list">${cards}</div>` : `
      <section class="hero">
        <h1>Match highlights and stats, free.</h1>
        <p>Pick a match recording. Pitchside finds the moments worth watching, you tag what happened, and it builds the stats and a highlight reel. Your video never leaves your phone.</p>
        <ol class="steps"><li><b>Choose</b> the match video</li><li><b>Scan</b> it (about 15 minutes per hour of footage)</li><li><b>Tag</b> goals, shots and saves</li></ol>
      </section>`}
    <a class="primary big" href="#/new">New match</a>
  </main>`;
}

// ============================================================ new match
function newMatch() {
  const today = new Date().toISOString().slice(0, 10);
  let dir = lsGet('ps_dir', 'right');
  app.innerHTML = `${topBar('New match')}<form id="nf" class="stack" autocomplete="off">
    <label class="fld"><span>Your team</span><input name="us" required value="${esc(lsGet('ps_us', ''))}" placeholder="e.g. Norton and Stockton"></label>
    <label class="fld"><span>Opponent</span><input name="them" required placeholder="e.g. Pools Youth"></label>
    <label class="fld"><span>Date</span><input type="date" name="date" value="${today}" required></label>
    <div class="fld"><span>Your team attacks (1st half)</span>${seg('dirSeg', [['left', '&#8592; Left'], ['right', 'Right &#8594;']], dir)}<small>As you look at the video. It flips at half-time.</small></div>
    <label class="fld"><span>Half-time at (minutes into the video)</span><input type="number" name="ht" min="1" step="0.5" inputmode="decimal" placeholder="Optional - defaults to the middle"></label>
    <div class="fld"><span>Match video</span>
      <label class="filebtn"><input type="file" id="vf" accept="video/*" hidden><span id="vfName">Choose video&hellip;</span></label>
      <small>Stays on this device. Nothing is uploaded.</small></div>
    <button class="primary" type="submit" id="nfGo">Continue</button></form>`;
  wireSeg('dirSeg', v => { dir = v; });
  let file = null;
  $('#vf').onchange = e => { file = e.target.files[0] || null; $('#vfName').textContent = file ? file.name : 'Choose video…'; };
  $('#nf').onsubmit = async ev => {
    ev.preventDefault();
    if (!file) return toast('Choose the match video first');
    const f = new FormData(ev.target), btn = $('#nfGo');
    btn.disabled = true; btn.textContent = 'Reading video…';
    let info;
    try { info = await probeVideo(file); } catch (_) { btn.disabled = false; btn.textContent = 'Continue'; return toast("This browser can't read that video. Try an .mp4 file."); }
    const m = { id: DB.newId(), us: f.get('us').trim(), them: f.get('them').trim(), date: f.get('date'), attackDir: dir,
      halfTime: f.get('ht') ? parseFloat(f.get('ht')) * 60 : 0, createdAt: Date.now(),
      video: { name: file.name, size: file.size, duration: info.duration }, events: null, curves: null, raw: null };
    lsSet('ps_us', m.us); lsSet('ps_dir', dir);
    await DB.saveMatch(m); setFile(m, file);
    go(`#/match/${m.id}`);
  };
}

// ============================================================ help
function help() {
  app.innerHTML = `${topBar('How it works')}<main class="stack prose">
    <section class="card"><h3>The idea</h3><p>Pitchside looks for the moments that <em>felt</em> big: crowd noise, whistles, fast breaks, the camera sweeping across the pitch. It can't tell a goal from a corner by itself, so you check each moment and tag it. The stats, chart and highlight reel are built from your tags.</p></section>
    <section class="card"><h3>Using it</h3><ol>
      <li><b>New match</b>: names, date and which way you attack, then pick the video.</li>
      <li><b>Scan</b>: the video plays silently at speed while it listens and watches. Keep the screen on. Use Quick (&times;8) for long matches.</li>
      <li><b>Moments</b>: tap play on each one, then say what happened and which team. Skip anything that isn't a highlight. Use <em>Add moment</em> for anything it missed.</li>
      <li><b>Summary</b>: score, match flow and head-to-head stats appear as you tag.</li></ol></section>
    <section class="card"><h3>Good to know</h3><ul>
      <li>Your video is never uploaded. Only names, tags and the scan results are saved, on this device.</li>
      <li>After you close the app, pick the video file again to watch clips. Tags stay.</li>
      <li>Too few or too many moments? Use the Sensitivity control on the Moments tab, no rescan needed.</li>
      <li>Match flow is an estimate from camera movement. It works best when the camera follows the play or covers the whole pitch.</li>
      <li>Works offline once opened. Not yet tested on a lot of real match footage, so expect to tweak.</li></ul></section>
    <section class="card"><h3>Install it</h3><p><b>iPhone:</b> Share &rarr; Add to Home Screen.<br><b>Android:</b> menu &rarr; Install app.</p></section>
  </main>`;
}

// ============================================================ match view
async function matchView(id, tab) {
  const m = await DB.getMatch(id);
  if (!m) return go('#/');
  if (S.scanning && S.scanning.id === id) return scanView(m);
  if (!m.events) return setupView(m);
  app.innerHTML = `${topBar(`${m.us} v ${m.them}`, fmtDate(m.date), { menu: true })}
    <nav class="tabs"><a href="#/match/${id}/summary" class="${tab !== 'moments' ? 'on' : ''}">Summary</a>
    <a href="#/match/${id}/moments" class="${tab === 'moments' ? 'on' : ''}">Moments <i class="count">${taggedCount(m)}/${m.events.filter(e => e.type !== 'skip').length}</i></a></nav>
    <main id="tabBody" class="stack"></main>`;
  wireMenu(m);
  if (tab === 'moments') momentsTab(m); else summaryTab(m);
}

// ------------------------------------------------------------ setup / scan
async function setupView(m) {
  await restoreBallModel();
  const has = haveFile(m);
  app.innerHTML = `${topBar(`${m.us} v ${m.them}`, fmtDate(m.date), { menu: true })}<main class="stack">
    <section class="card">
      <h2>Scan the match</h2>
      <p class="lead">Pitchside plays the video quickly and silently, listening for crowd noise and whistles and watching for fast play, to flag the moments worth reviewing.</p>
      ${has ? `<div class="filechip"><b>${esc(S.file.name)}</b><small>${clock(m.video.duration)} long</small></div>`
            : `<div class="filechip warn"><b>Attach the match video to continue</b><small>${esc(m.video && m.video.name || '')}</small></div>
               <label class="btn ghost filebtn"><input id="vfile" type="file" accept="video/*" hidden>Choose video</label>`}
      <div class="fld"><span>Scan speed</span>${seg('rateSeg', [[4, 'Thorough &middot; &times;4'], [8, 'Quick &middot; &times;8']], S.rate)}<small id="eta"></small></div>
      <button class="primary" id="goScan" ${has ? '' : 'disabled'}>Scan match</button>
      <p class="hint">Keep this screen open and awake while it scans. Nothing leaves your device.</p>
    </section>
    <section class="card quiet"><h3>Is there a scoreboard on the video?</h3>
      <p>Optional. Mark where the two score numbers are and the scan will notice every time one changes. That gives you the goal times and who scored, automatically.</p>
      <p class="note" id="sbState">${m.scoreBoxes ? 'Score area set. It will be read during the scan.' : ''}</p>
      <button class="ghost wide" id="markScore" ${has ? '' : 'disabled'}>${m.scoreBoxes ? 'Change the score area' : 'Mark the score area'}</button></section>
    <section class="card quiet" id="smartCard"><h3>Smart goal finder (beta)</h3>
      <p>Combines every clue: the scoreboard, ball tracking, crowd noise, cheering and whistles, and anyone shouting &ldquo;goal&rdquo;. Tell it the final score and it keeps that many of the most likely goals.</p>
      <button class="ghost wide" id="goSmart">Open the smart goal finder</button></section>
    <section class="card quiet" id="ballCard"><h3>Track the ball (beta)</h3>
      <p>Uses a football ball detector that runs in your browser to find the goals itself: the ball reaching a goal, then a kick-off from the centre spot. It is slow but needs no tagging. You need a ball model file (<code>.onnx</code>), loaded once.</p>
      <p class="note" id="ballState">${ballStateText()}</p>
      <label class="btn ghost filebtn"><input id="ballModel" type="file" accept=".onnx" hidden>${S.ball.name ? 'Use a different model file' : 'Choose the ball model (.onnx)'}</label>
      <div class="fld"><span>Detail</span>${seg('ballSeg', [[1, 'Quick &middot; 1/s'], [2, 'Balanced &middot; 2/s'], [3, 'Thorough &middot; 3/s']], S.ballFps)}<small id="ballEta"></small></div>
      <button class="ghost wide" id="goBall" ${has && S.ball.name ? '' : 'disabled'}>Track the ball and find goals</button></section>
    <section class="card quiet"><h3>Skip the scan?</h3>
      <p>If you already know when the goals were scored, skip scanning and just type the times in. Pitchside then builds the highlights video with a score graphic.</p>
      <button class="ghost wide" id="skipScan">Skip scan, enter goal times</button></section>
    <section class="card quiet"><h3>Already analysed on a computer?</h3>
      <p>Import the <code>events.json</code> made by the desktop script.</p>
      <label class="btn ghost"><input id="ifile" type="file" accept=".json,application/json" hidden>Import analysis</label></section>
  </main>`;
  wireMenu(m);
  const eta = () => { const d = m.video && m.video.duration; $('#eta').textContent = d ? `About ${Math.max(1, Math.ceil(d / S.rate / 60))} min` : ''; };
  eta();
  wireSeg('rateSeg', v => { S.rate = +v; eta(); });
  const vf = $('#vfile');
  if (vf) vf.onchange = e => attachFile(m, e.target.files[0], () => setupView(m));
  const gb = $('#goScan'); if (gb) gb.onclick = () => startScan(m);
  const bm = $('#ballModel'); if (bm) bm.onchange = e => chooseBallModel(m, e.target.files[0]);
  wireSeg('ballSeg', v => { S.ballFps = +v; ballEta(m); }); ballEta(m);
  const gbl = $('#goBall'); if (gbl) gbl.onclick = () => runBallScan(m);
  const gsm = $('#goSmart'); if (gsm) gsm.onclick = () => smartFinder(m);
  const ms = $('#markScore'); if (ms) ms.onclick = () => markScoreArea(m, () => setupView(m));
  $('#skipScan').onclick = async () => { m.events = []; m.curves = null; m.raw = null; m.duration = m.video.duration; m.half = m.halfTime || m.duration / 2; await DB.saveMatch(m); go(`#/match/${m.id}/moments`); };
  $('#ifile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await importAnalysis(m, f); await DB.saveMatch(m); toast('Analysis imported'); go(`#/match/${m.id}/moments`); }
    catch (err) { toast(err.message || 'Could not read that file'); }
  };
}
function attachFile(m, f, after) {
  if (!f) return;
  if (m.video && m.video.size && f.size !== m.video.size && !confirm('This looks like a different file from the one you scanned. Use it anyway?')) return;
  setFile(m, f); after();
}
async function importAnalysis(m, file) {
  let j; try { j = JSON.parse(await file.text()); } catch (_) { throw new Error('That is not a valid analysis file'); }
  if (!j.events || !j.curves) throw new Error('That file is missing events or curves');
  m.events = j.events.map((e, i) => ({ id: i + 1, time: e.time, start: e.start, end: e.end, score: e.score ?? null, label: e.label || 'Moment',
    type: (e.type && TYPES[e.type]) ? e.type : null, side: e.side || null }));
  const c = j.curves;
  m.curves = c.us ? { t: c.t, us: c.us, them: c.them } : { t: c.t, us: c.attack, them: c.defence };
  m.duration = j.duration || (m.video && m.video.duration) || 0;
  m.half = j.half || m.duration / 2;
  m.raw = j.raw || null; m.hasAudio = j.has_audio ?? j.hasAudio ?? null;
}

function drawSpark(vals) {
  const c = $('#spark'); if (!c) return;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  const mx = Math.max(1e-6, ...vals), bw = w / 120;
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--us').trim() || '#14804A';
  vals.slice(-120).forEach((v, i) => { const bh = Math.max(2, h * v / mx); ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh); });
}
function scanView(m) {
  app.innerHTML = `${topBar(`${m.us} v ${m.them}`, 'Scanning', { back: '#/' })}<main class="stack">
    <section class="card scan">
      <h2 id="spct">0%</h2>
      <div class="bar"><i id="sbar" style="width:0%"></i></div>
      <p id="seta" class="lead">Starting&hellip;</p>
      <canvas id="spark" width="480" height="64" aria-hidden="true"></canvas>
      <p class="hint">Keep this tab in front and the screen awake. If you switch away, the scan pauses until you return. The scan is silent and nothing leaves your device.</p>
      <button class="ghost wide" id="cancel">Cancel</button>
    </section></main>`;
  $('#cancel').onclick = () => S.scanning && S.scanning.ctrl.abort();
  drawSpark(S.scanning.spark);
}
async function startScan(m) {
  const ctrl = new AbortController();
  S.scanning = { id: m.id, ctrl, spark: [] };
  scanView(m);
  try {
    const res = await scanVideo(S.file, {
      rate: S.rate, sampleFps: 2, signal: ctrl.signal, scoreBoxes: m.scoreBoxes || null,
      onProgress: p => {
        const sc = S.scanning; if (!sc) return;
        sc.spark.push(p.resid); if (sc.spark.length > 400) sc.spark.shift();
        const pct = Math.round(p.frac * 100);
        const left = p.frac > 0.02 ? p.elapsed / p.frac * (1 - p.frac) : null;
        if ($('#spct')) {
          $('#spct').textContent = pct + '%'; $('#sbar').style.width = pct + '%';
          if (p.hidden) $('#seta').textContent = 'Paused: come back to this tab and the scan carries on.'; else
          $('#seta').textContent = `${clock(p.t)} of ${clock(p.duration)} scanned` + (left != null ? ` · about ${Math.max(1, Math.ceil(left / 60))} min left` : '');
          drawSpark(sc.spark);
        }
      },
    });
    m.raw = res.raw; m.duration = res.duration; m.hasAudio = res.hasAudio; m.partialTo = res.partial ? res.coveredTo : null;
    const out = processSignals(res.raw, res.duration, { halfTime: m.halfTime, attackDir: m.attackDir, sampleFps: res.sampleFps });
    m.events = out.events; m.curves = out.curves; m.half = out.half; m.sens = 'normal';
    await DB.saveMatch(m);
    S.scanning = null;
    m.frameCoverage = res.frameCoverage;
    if (res.raw.scoreDiff) {
      const sc = findScoreChanges(res.raw.scoreDiff, res.sampleFps), homeSide = m.scoreHome || 'us';
      m.scoreNoisy = sc.noisy;
      m.scoreEvents = sc.changes.map(c => { const side = c.side === 'h' ? homeSide : (homeSide === 'us' ? 'them' : 'us');
        return { seen: c.time, side, time: snapToRoar(res.raw, res.duration, c.time, { sampleFps: res.sampleFps }) }; });
    }
    await DB.saveMatch(m);
    if (res.frameCoverage != null && res.frameCoverage < 0.9) setTimeout(() => toast('Part of the video was not scanned properly. Keep this tab in front and scan again.'), 2600);
    toast(res.partial ? `Scan stopped early at ${clock(res.coveredTo)}` : `Found ${m.events.length} moments to review`);
    go(`#/match/${m.id}/moments`);
  } catch (err) {
    S.scanning = null;
    if (err && err.name === 'AbortError') toast('Scan cancelled'); else toast(err.message || 'The scan failed');
    go(`#/match/${m.id}`);
  }
}

// ------------------------------------------------------------ summary
function flowChart(m) {
  const W = 600, H = 262, mid = 118, amp = 84, pad = 10, dur = m.duration, c = m.curves;
  const X = t => pad + (W - 2 * pad) * Math.min(1, t / dur);
  const yU = v => mid - amp * v / 100, yT = v => mid + amp * v / 100;
  const pts = (arr, f) => c.t.map((t, i) => `${X(t).toFixed(1)},${f(arr[i]).toFixed(1)}`);
  const area = (arr, f) => `M${X(c.t[0]).toFixed(1)},${mid} L${pts(arr, f).join(' L')} L${X(c.t[c.t.length - 1]).toFixed(1)},${mid} Z`;
  const line = (arr, f) => `M${pts(arr, f).join(' L')}`;
  const step = dur > 5400 ? 1800 : dur > 2400 ? 900 : dur > 900 ? 300 : 60;
  let ticks = '';
  for (let t = 0; t <= dur + 1; t += step) ticks += `<text x="${X(t).toFixed(1)}" y="256" text-anchor="${t === 0 ? 'start' : 'middle'}">${Math.round(t / 60)}'</text>`;
  const hx = X(m.half || dur / 2).toFixed(1);
  let marks = '';
  for (const e of m.events) {
    if (e.type === 'skip') continue;
    if (e.type && e.side) {
      const T = TYPES[e.type], y = e.side === 'us' ? 15 : 226;
      marks += `<g class="mk ${e.side}${T.hollow ? ' hollow' : ''}" data-id="${e.id}"><circle r="17" cx="${X(e.time).toFixed(1)}" cy="${y}" fill="transparent"/>
        <circle class="dot" r="10.5" cx="${X(e.time).toFixed(1)}" cy="${y}"/><text class="mt" x="${X(e.time).toFixed(1)}" y="${y + 4}" text-anchor="middle">${T.ch}</text></g>`;
    } else {
      marks += `<g class="mk raw" data-id="${e.id}"><circle r="12" cx="${X(e.time).toFixed(1)}" cy="${mid}" fill="transparent"/><circle class="udot" r="3.5" cx="${X(e.time).toFixed(1)}" cy="${mid}"/></g>`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Match flow chart: pressure for your team above the line, for the opponent below">
    <path d="${area(c.us, yU)}" class="a-us"/><path d="${area(c.them, yT)}" class="a-them"/>
    <line x1="${pad}" x2="${W - pad}" y1="${mid}" y2="${mid}" class="axis"/>
    <line x1="${hx}" x2="${hx}" y1="26" y2="212" class="ht"/>
    <path d="${line(c.us, yU)}" class="l-us"/><path d="${line(c.them, yT)}" class="l-them"/>
    ${ticks}<text x="${hx}" y="248" text-anchor="middle" class="htl">HT</text>
    ${marks}</svg>`;
}
function h2hRow(label, a, b) {
  const mx = Math.max(a, b, 1);
  return `<div class="h2h"><div class="hd"><b class="us">${a}</b><span>${label}</span><b class="them">${b}</b></div>
    <div class="bars"><div class="half l"><i style="width:${a / mx * 100}%"></i></div><div class="half r"><i style="width:${b / mx * 100}%"></i></div></div></div>`;
}
function summaryTab(m) {
  const st = stats(m), tagged = taggedCount(m), total = m.events.filter(e => e.type !== 'skip').length;
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const hasCurves = !!(m.curves && m.curves.us && m.curves.us.length);
  const U = hasCurves ? mean(m.curves.us) : 0, T = hasCurves ? mean(m.curves.them) : 0, upct = Math.round(100 * U / ((U + T) || 1));
  const pct = (n, d) => d ? Math.round(100 * n / d) + '%' : '–';
  $('#tabBody').innerHTML = `
    ${m.partialTo ? `<div class="notice">The scan stopped early at ${clock(m.partialTo)}, so later moments aren't covered.</div>` : ''}
    <section class="score"><div class="side us"><b>${st.us.goals}</b><span>${esc(m.us)}</span></div><div class="dash">–</div><div class="side them"><b>${st.them.goals}</b><span>${esc(m.them)}</span></div></section>
    ${tagged ? '' : `<div class="notice">Nothing tagged yet. <a href="#/match/${m.id}/moments">Review the ${total} moments</a> to fill in the score and stats.</div>`}
    ${hasCurves ? `<section class="card"><div class="cardhd"><h3>Match flow</h3><div class="legend"><span class="us">${esc(m.us)}</span><span class="them">${esc(m.them)}</span></div></div>
      <div id="chart" class="chart">${flowChart(m)}</div>
      <div class="share"><span class="us" style="width:${upct}%">${upct}%</span><span class="them" style="width:${100 - upct}%">${100 - upct}%</span></div>
      <p class="note">Estimated share of the play, from camera movement and crowd noise. Tap a marker to watch it.</p></section>` : ''}
    <section class="card"><h3>Head to head</h3>
      ${h2hRow('Goals', st.us.goals, st.them.goals)}${h2hRow('Shots', st.us.shots, st.them.shots)}${h2hRow('On target', st.us.sot, st.them.sot)}
      ${h2hRow('Corners', st.us.corners, st.them.corners)}${h2hRow('Saves', st.us.saves, st.them.saves)}${h2hRow('Fouls', st.us.fouls, st.them.fouls)}
      <div class="derived"><div><b>${pct(st.us.goals, st.us.shots)}</b><span>Our conversion</span></div><div><b>${pct(st.us.sot, st.us.shots)}</b><span>Our accuracy</span></div>
      <div><b>${pct(st.them.goals, st.them.shots)}</b><span>Their conversion</span></div></div>
      <p class="note">Built from the ${tagged} of ${total} moments you've tagged. A save counts as a shot on target for the other side.</p></section>
    <button class="ghost wide" id="dlData">&#11015; Download match data (.csv)</button>
    <a class="primary" href="#/match/${m.id}/moments">${tagged < total ? 'Review moments' : 'Play highlights'}</a>`;
  $('#dlData').onclick = () => downloadMatchData(m);
  if ($('#chart')) $('#chart').onclick = ev => {
    const g = ev.target.closest('.mk'); if (!g) return;
    S.pendingPlay = +g.dataset.id; go(`#/match/${m.id}/moments`);
  };
}

// ------------------------------------------------------------ moments
const LEVELS = { fewer: { minScore: 1.6, maxClipsMult: 0.6 }, normal: { minScore: 0.8, maxClipsMult: 1 }, more: { minScore: 0.2, maxClipsMult: 2.2 } };
function momCard(e, playing) {
  const tagged = e.type && e.type !== 'skip', skip = e.type === 'skip';
  return `<article class="mom${skip ? ' skip' : ''}${playing ? ' playing' : ''}${tagged ? ' tagged' : ''}" data-id="${e.id}">
    <div class="row"><button class="play" data-act="play" aria-label="Play moment at ${clock(e.time)}">&#9654;</button>
      <div class="meta"><b>${clock(e.time)}</b><small>${esc(e.label)}</small></div>
      <button class="ghost sm" data-act="skip">${skip ? 'Restore' : 'Skip'}</button></div>
    ${skip ? '' : `<div class="tag"><select data-act="type" aria-label="What happened"><option value="">What happened?</option>
      ${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${e.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
      ${tagged ? `<div class="seg sm" data-act="side"><button data-side="us" class="${e.side === 'us' ? 'on' : ''}">Us</button><button data-side="them" class="${e.side === 'them' ? 'on' : ''}">Them</button></div>` : ''}</div>`}
  </article>`;
}
function reelList(m) {
  const tagged = m.events.filter(e => e.type && e.type !== 'skip');
  const base = tagged.length ? tagged.filter(e => e.type !== 'foul') : m.events.filter(e => e.type !== 'skip');
  return [...base].sort((a, b) => a.time - b.time);
}
function renderMoments(m) {
  const list = $('#momentList'); if (!list) return;
  list.innerHTML = m.events.length ? m.events.map(e => momCard(e, S.clipId === e.id)).join('') : '<p class="note">No moments yet. Play the video and use “Add moment”.</p>';
  const rl = reelList(m); const b = $('#playReel'); if (b) { b.textContent = `Play highlights (${rl.length})`; b.disabled = !rl.length; }
  $$('.count').forEach(c => c.textContent = `${taggedCount(m)}/${m.events.filter(e => e.type !== 'skip').length}`);
  updateVidInfo(m);
}
function needVideo() { toast('Attach the match video first'); const a = $('#playerWrap'); if (a) a.scrollIntoView({ behavior: 'smooth' }); }
function playClip(e) {
  const v = $('#vid'); if (!v) return needVideo();
  S.clipEnd = e.end; S.clipId = e.id;
  const goTo = () => { S.ourSeek = true; v.currentTime = e.start; v.play().catch(() => {}); };
  if (v.readyState >= 1) goTo(); else v.addEventListener('loadedmetadata', goTo, { once: true });
  $$('.mom').forEach(c => c.classList.toggle('playing', +c.dataset.id === e.id));
}
function updateReelBar() {
  const bar = $('#reelbar'); if (!bar) return;
  if (!S.reel) { bar.hidden = true; return; }
  bar.hidden = false; $('#reelTxt').textContent = `Highlight ${S.reel.i + 1} of ${S.reel.list.length} · ${clock(S.reel.list[S.reel.i].time)}`;
}
function nextReel(step = 1) {
  const r = S.reel; if (!r) return;
  r.i += step; if (r.i < 0) r.i = 0;
  if (r.i >= r.list.length) { stopReel(); return toast('Highlights finished'); }
  playClip(r.list[r.i]); updateReelBar();
}
function stopReel() { S.reel = null; S.clipEnd = null; const v = $('#vid'); if (v) v.pause(); updateReelBar(); }

function applySensitivity(m, key) {
  const out = processSignals(m.raw, m.duration, { ...LEVELS[key], halfTime: m.halfTime, attackDir: m.attackDir, sampleFps: 2 });
  const keep = m.events.filter(e => e.manual || e.type);
  const merged = [...keep];
  for (const f of out.events) if (keep.every(k => Math.abs(k.time - f.time) >= 30)) merged.push(f);
  merged.sort((a, b) => a.time - b.time);
  merged.forEach((e, i) => e.id = i + 1);
  m.events = merged; m.sens = key;
}


// ------------------------------------------------------------ goals by time, scoreline, highlights video
const goalsOf = m => m.events.filter(e => e.type === 'goal' && e.side).sort((a, b) => a.time - b.time);
function scoreAt(m, t, inclusive) {
  const r = { us: 0, them: 0 };
  for (const e of goalsOf(m)) if (inclusive ? e.time <= t : e.time < t) r[e.side]++;
  return r;
}
function parseClockTime(str) {
  const p = str.split(':').map(Number); if (p.some(n => !isFinite(n))) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : null;
}
function sideFromText(m, t) {
  const x = t.toLowerCase().trim(); if (!x) return null;
  const first = n => String(n).toLowerCase().split(/\s+/)[0];
  if (/^(us|we|home|ours|our)\b/.test(x) || x.startsWith(first(m.us))) return 'us';
  if (/^(them|they|away|opp|opposition|theirs)\b/.test(x) || x.startsWith(first(m.them))) return 'them';
  return null;
}
function addGoalAt(m, t, side) {
  const pre = m.preGoal ?? 10, post = m.postGoal ?? 10, dur = m.duration || t + post;
  const near = m.events.find(e => e.type !== 'skip' && (e.type === 'goal' || !e.type) && Math.abs(e.time - t) < 15);
  if (near) {
    near.type = 'goal'; near.manual = true; near.guess = false; near.label = 'Goal'; if (side) near.side = side;
    near.time = t; near.start = Math.max(0, t - pre); near.end = Math.min(dur, t + post);
    return near;
  }
  const e = { id: 0, time: t, start: Math.max(0, t - pre), end: Math.min(dur, t + post), score: null, label: 'Goal', type: 'goal', side: side || null, manual: true };
  m.events.push(e); return e;
}
function finishEventEdit(m) {
  m.events.sort((a, b) => a.time - b.time); m.events.forEach((e, i) => e.id = i + 1);
  DB.saveMatch(m); renderMoments(m); updateGoalStatus(m); updateVidInfo(m);
}
function addGoalsFromText(m) {
  const raw = $('#goalTimes').value; if (!raw.trim()) return toast('Type the goal times first');
  const bad = []; let n = 0;
  for (const part of raw.split(/[\n;,]+/).map(x => x.trim()).filter(Boolean)) {
    const mt = part.match(/^(\d{1,2}:)?\d{1,3}:\d{2}/);
    const t = mt ? parseClockTime(mt[0]) : null;
    if (t == null) { bad.push(part); continue; }
    if (m.duration && t > m.duration + 1) { bad.push(part + ' (past the end of the video)'); continue; }
    addGoalAt(m, t, sideFromText(m, part.slice(mt[0].length).replace(/^[\s\-:]+/, ''))); n++;
  }
  finishEventEdit(m);
  if (n) $('#goalTimes').value = '';
  toast(bad.length ? `Added ${n}. Could not read: ${bad.join(', ')}` : `Added ${n} goal${n === 1 ? '' : 's'}. Check who scored on each.`);
}
function clipsFor(m, mode) {
  const pre = m.preGoal ?? 10, post = m.postGoal ?? 10, dur = m.duration || 1e9;
  let list = m.events.filter(e => e.type && e.type !== 'skip' && e.type !== 'foul' && TYPES[e.type]).sort((a, b) => a.time - b.time);
  if (mode === 'goals') list = list.filter(e => e.type === 'goal');
  const clips = list.map(e => {
    if (e.type === 'goal') {
      const before = scoreAt(m, e.time, false), after = e.side ? scoreAt(m, e.time, true) : before;
      return { kind: 'goal', label: 'Goal', side: e.side, goalAt: e.time, start: Math.max(0, e.time - pre), end: Math.min(dur, e.time + post), before, after: e.side ? after : null, id: e.id };
    }
    const sc = scoreAt(m, e.time, true);
    return { kind: 'other', label: `${TYPES[e.type].label}${e.side ? ' · ' + (e.side === 'us' ? m.us : m.them) : ''}`, side: e.side, start: e.start, end: Math.min(dur, e.end), before: sc, after: sc, id: e.id };
  }).sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of clips) {
    const p = out[out.length - 1];
    if (p && c.start < p.end) {
      if (c.kind === 'goal' && p.kind !== 'goal') { p.end = Math.min(p.end, c.start); if (p.end - p.start < 3) out.pop(); }
      else { c.start = p.end; if (c.end - c.start < 3) continue; }
    }
    out.push(c);
  }
  return out;
}
function updateVidInfo(m) {
  const el = $('#vidInfo'); if (!el) return;
  const mode = $('#vidMode .on') ? $('#vidMode .on').dataset.v : 'all';
  const clips = clipsFor(m, mode), secs = clips.reduce((s, c) => s + c.end - c.start, 0) + 6;
  const g = goalsOf(m), open = m.events.filter(e => e.type === 'goal' && !e.side).length;
  let t = clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'}, about ${clock(secs)} long. Score so far ${m.us} ${g.filter(e => e.side === 'us').length}–${g.filter(e => e.side === 'them').length} ${m.them}.`
                       : 'Nothing to put in a video yet. Add goal times below, or tag some moments.';
  if (open) t += ` ${open} goal${open === 1 ? ' needs' : 's need'} a team picking first.`;
  el.textContent = t;
  const b = $('#makeVideo'); if (b) b.disabled = !clips.length || !haveFile(m);
}
function videoResultCard(m) {
  const v = S.video; if (!v || v.matchId !== m.id) return '';
  const mb = (v.blob.size / 1048576).toFixed(1);
  return `<section class="card" id="vidResult"><h3>Your highlights video</h3>
    <p class="note">${v.clips} clip${v.clips === 1 ? '' : 's'}, ${clock(v.seconds)} long, ${v.ext.toUpperCase()} file, ${mb} MB. Made ${esc(v.when)}. It stays here until you close or reload the app, so download it now.</p>
    <video controls playsinline preload="metadata" src="${v.url}" style="width:100%;border-radius:12px;margin:8px 0"></video>
    <a class="primary wide dl" id="dlVideo" href="${v.url}" download="${esc(v.name)}">&#11015; Download highlights</a>
    ${v.canShare ? '<button class="ghost wide" id="shareVideo">Share&hellip;</button>' : ''}
    <button class="ghost wide" id="againVideo">Make it again</button></section>`;
}
function wireVideoResult(m) {
  const sh = $('#shareVideo'); if (sh) sh.onclick = () => navigator.share({ files: [new File([S.video.blob], S.video.name, { type: S.video.blob.type })], title: `${m.us} v ${m.them}` }).catch(() => {});
  const ag = $('#againVideo'); if (ag) ag.onclick = () => runExport(m);
}
function highlightCards(m) {
  const has = haveFile(m);
  return `<div id="vidResultWrap">${videoResultCard(m)}</div><section class="card" id="vidCard"><h3>Highlights video</h3>
    <p class="note" id="vidInfo"></p>
    <div class="fld"><span>What to include</span>${seg('vidMode', [['all', 'Goals + highlights'], ['goals', 'Goals only']], m.vidMode || 'all')}</div>
    <div class="fld"><span>Seconds around each goal</span><div class="fs"><label>Before<input id="preGoal" type="number" min="3" max="60" inputmode="numeric" value="${m.preGoal ?? 10}"></label>
      <label>After<input id="postGoal" type="number" min="3" max="60" inputmode="numeric" value="${m.postGoal ?? 10}"></label></div></div>
    <button class="primary wide" id="makeVideo" ${has ? '' : 'disabled'}>Make highlights video</button>
    <p class="note">Adds a score graphic and a GOAL banner, then saves a video file you can share. It plays the clips in real time, so a 3 minute video takes about 3 minutes. Keep this tab in front while it works.</p></section>
  <section class="card"><h3>Enter goal times</h3>
    <p class="note">Type the time shown in the video player, one per line, with who scored. For example:</p>
    <pre class="eg">12:34 ${esc(m.us)}\n34:33 ${esc(m.them)}\n1:02:10 us</pre>
    <textarea id="goalTimes" rows="4" placeholder="12:34 ${esc(m.us)}"></textarea>
    <button class="ghost wide" id="addGoals">Add these goals</button></section>`;
}
function wireHighlightCards(m) {
  const pg = $('#preGoal'), po = $('#postGoal');
  const num = (el, d) => Math.max(3, Math.min(60, parseInt(el.value, 10) || d));
  if (pg) pg.onchange = () => { m.preGoal = num(pg, 10); DB.saveMatch(m); updateVidInfo(m); };
  if (po) po.onchange = () => { m.postGoal = num(po, 10); DB.saveMatch(m); updateVidInfo(m); };
  wireSeg('vidMode', v => { m.vidMode = v; DB.saveMatch(m); updateVidInfo(m); });
  const ag = $('#addGoals'); if (ag) ag.onclick = () => addGoalsFromText(m);
  const mv = $('#makeVideo'); if (mv) mv.onclick = () => runExport(m);
  wireVideoResult(m); updateVidInfo(m);
}
async function runExport(m) {
  if (!haveFile(m)) return needVideo();
  if (!pickMime()) return toast("This browser can't record video. Use Chrome or Edge on a computer.");
  if (m.events.some(e => e.type === 'goal' && !e.side)) return toast('Pick who scored on each goal first (Us / Them)');
  const mode = $('#vidMode .on') ? $('#vidMode .on').dataset.v : 'all';
  const clips = clipsFor(m, mode); if (!clips.length) return toast('Nothing to export yet');
  stopReel();
  const g = goalsOf(m), fin = { us: g.filter(e => e.side === 'us').length, them: g.filter(e => e.side === 'them').length };
  const ctrl = new AbortController();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-label="Making video"><h4>Making your highlights video</h4>
    <div class="bar"><i id="xbar" style="width:0%"></i></div><p class="note" id="xtxt">Starting&hellip;</p>
    <div id="xdone"></div><button class="cancel" id="xcancel">Cancel</button></div>`;
  document.body.appendChild(scrim);
  $('#xcancel').onclick = () => { ctrl.abort(); scrim.remove(); };
  try {
    const res = await makeHighlightsVideo(S.file, {
      clips, us: m.us, them: m.them, title: 'Highlights', dateText: fmtDate(m.date), finalScore: fin, signal: ctrl.signal,
      onProgress: p => { const b = $('#xbar'); if (b) { b.style.width = Math.round(p.frac * 100) + '%'; $('#xtxt').textContent = `${Math.round(p.frac * 100)}% · ${clock(p.done)} of ${clock(p.total)}. Keep this tab in front.`; } },
    });
    if (S.video && S.video.url) URL.revokeObjectURL(S.video.url);
    const name = `${slug(m.us)}-v-${slug(m.them)}-highlights.${res.ext}`;
    const canShare = !!(navigator.canShare && navigator.maxTouchPoints > 1 && navigator.canShare({ files: [new File([res.blob], name, { type: res.mime })] }));
    S.video = { matchId: m.id, blob: res.blob, url: URL.createObjectURL(res.blob), name, ext: res.ext, seconds: res.seconds, clips: clips.length, canShare, when: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) };
    scrim.remove();
    const wrap = $('#vidResultWrap');
    if (wrap) { wrap.innerHTML = videoResultCard(m); wireVideoResult(m); const pl = $('.player'), off = (pl ? pl.getBoundingClientRect().bottom : 0) + 10; window.scrollTo({ top: wrap.getBoundingClientRect().top + window.scrollY - off }); }
    toast(res.hasAudio ? 'Your video is ready. Tap Download highlights.' : 'Your video is ready (no sound).');
  } catch (err) {
    scrim.remove();
    if (!(err && err.name === 'AbortError')) toast(err.message || 'Could not make the video');
  }
}

// ------------------------------------------------------------ smart goal finder
S.yam = null;
function evidenceFor(m, n) {
  const ev = [], notes = {};
  if (m.raw) {
    const cs = findGoals(m.raw, m.duration, { n: Math.max(12, (n || 6) * 3), halfTime: m.halfTime, sampleFps: 2, model: loadModel() });
    const top = Math.max(0.0001, ...cs.map(c => c.score));
    cs.forEach(c => ev.push({ src: 'crowd', t: c.time, conf: 0.2 + 0.3 * (c.score / top) })); notes.crowd = cs.length;
  }
  if (m.scoreEvents && m.scoreEvents.length) { m.scoreEvents.forEach(e => ev.push({ src: 'board', t: e.time, conf: m.scoreNoisy ? 0.35 : 0.9, side: e.side })); notes.board = m.scoreEvents.length; }
  if (m.ballTrack) {
    const pts = cleanTrack(m.ballTrack.rows, m.ballTrack.duration || m.duration);
    if (pts.length >= 20) {
      const z = m.ballTrack.zones || suggestZones(pts);
      const cs = findCandidates(pts, z, { sampleFps: m.ballTrack.fps || 2 });
      cs.forEach(c => ev.push({ src: c.restart ? 'ball' : 'ballMaybe', t: c.time, conf: c.restart ? 0.65 : 0.25 })); notes.ball = cs.length;
    }
  }
  if (m.sound) { const se = soundEvents(m.sound); ev.push(...se); notes.cheer = se.length; }
  if (m.speech) { const sp = speechEvents(m.speech); ev.push(...sp); notes.speech = sp.length; }
  if (m.gemini) { const ge = geminiEvents(m.gemini); ev.push(...ge); notes.gemini = ge.length; }
  return { ev, notes };
}
const G = { key: lsGet('ps_gemini_key', ''), rem: !!lsGet('ps_gemini_key', ''), ok: false, models: null, model: '' };
function smartFinder(m) {
  if (!haveFile(m) && !m.raw && !m.scoreEvents && !m.ballTrack) return needVideo();
  let ctrl = null, picks = new Set(), cands = [], busy = false;
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  document.body.appendChild(scrim);
  const status = (ok, text) => `<span class="${ok ? 'ok' : 'no'}">${ok ? '&#10003;' : '&ndash;'}</span> ${text}`;
  let typed = (m.finalUs != null && m.finalThem != null) ? [String(m.finalUs), String(m.finalThem)] : ['', ''];
  const render = (msg) => {
    if ($('#sfUs')) typed = [$('#sfUs').value, $('#sfThem').value];   // keep what was typed across redraws
    readG();
    const score = typed;
    scrim.innerHTML = `<div class="sheet wide" role="dialog" aria-label="Smart goal finder"><h4>Smart goal finder</h4>
      <div class="fs"><label>${esc(m.us)}<input id="sfUs" type="number" inputmode="numeric" min="0" max="30" value="${score[0]}"></label>
        <label>${esc(m.them)}<input id="sfThem" type="number" inputmode="numeric" min="0" max="30" value="${score[1]}"></label></div>
      <p class="note">Final score (optional, but it makes the result much better).</p>
      <ul class="evs">
        <li>${status(!!m.raw, 'Crowd noise &mdash; ' + (m.raw ? 'from the match scan' : 'run <b>Scan match</b> on the setup screen first'))}</li>
        <li>${status(!!(m.scoreEvents && m.scoreEvents.length), 'Scoreboard &mdash; ' + (m.scoreEvents ? m.scoreEvents.length + ' score changes' : 'not marked (optional)'))}</li>
        <li>${status(!!m.ballTrack, 'Ball tracking &mdash; ' + (m.ballTrack ? 'done' : 'run it from the setup screen (optional)'))}</li>
        <li>${status(!!m.sound, 'Cheering and whistles &mdash; ' + (m.sound ? 'done' : 'not run'))} <button class="ghost sm" id="sfSound" ${busy ? 'disabled' : ''}>${m.sound ? 'Redo' : 'Listen'}</button></li>
        <li>${status(!!m.speech, 'Spoken &ldquo;goal&rdquo; &mdash; ' + (m.speech ? m.speech.hits.length + ' mentions in ' + m.speech.words + ' words heard' : 'not run (needs voices on the recording)'))} <button class="ghost sm" id="sfSpeech" ${busy ? 'disabled' : ''}>${m.speech ? 'Redo' : 'Listen'}</button></li>
      </ul>
      <div class="gem">
        <b>Ask Gemini <small>(watches the video &mdash; needs your own free key)</small></b>
        <p class="note">${m.gemini ? `Done: Gemini found ${m.gemini.goals.length} goal${m.gemini.goals.length === 1 ? '' : 's'} (${esc(m.gemini.model)}).` : 'Gemini is Google&rsquo;s AI. It watches the whole match and lists the goals. Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>.'}</p>
        <input id="gKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your Gemini key" value="${esc(G.key)}">
        ${G.models ? `<select id="gModel">${G.models.map(x => `<option value="${esc(x.name)}" ${x.name === G.model ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
        <label class="chk"><input type="checkbox" id="gOk" ${G.ok ? 'checked' : ''}><span>I&rsquo;m happy for this video to be uploaded to Google with my key. (Google may use free-tier uploads to improve its products, so avoid footage you should not share, such as other people&rsquo;s children.)</span></label>
        <label class="chk"><input type="checkbox" id="gRem" ${G.rem ? 'checked' : ''}><span>Remember the key on this device</span></label>
        <div class="gbtns"><button class="ghost" id="sfGem" ${busy ? 'disabled' : ''}>${m.gemini ? 'Ask again' : 'Ask Gemini'}</button><button class="ghost" id="gForget" ${G.key && !busy ? '' : 'hidden'}>Forget key</button></div>
      </div>
      <p class="note" id="sfMsg">${msg || ''}</p>
      <div id="sfList"></div>
      <button class="primary wide" id="sfGo" ${busy ? 'disabled' : ''}>Find the goals</button>
      <button class="primary wide" id="sfAdd" hidden></button>
      <button class="cancel" id="sfClose">${busy ? 'Cancel' : 'Close'}</button></div>`;
    $('#sfClose').onclick = () => { if (ctrl) ctrl.abort(); scrim.remove(); };
    $('#sfSound').onclick = () => runSound(); $('#sfSpeech').onclick = () => runSpeech(); $('#sfGo').onclick = () => combine();
    $('#sfGem').onclick = () => runGemini(); $('#gForget').onclick = () => { G.key = ''; G.models = null; G.rem = false; lsSet('ps_gemini_key', ''); render('Key forgotten.'); };
  };
  const readG = () => { if ($('#gKey')) { G.key = $('#gKey').value.trim(); G.ok = $('#gOk').checked; G.rem = $('#gRem').checked; if ($('#gModel')) G.model = $('#gModel').value; } };
  const setMsg = t => { const e = $('#sfMsg'); if (e) e.textContent = t; };
  const needAudio = () => { if (!haveFile(m)) { toast('Attach the match video first'); return false; } if (!audioSupported()) { setMsg('This needs Chrome or Edge on a computer.'); return false; } return true; };
  const wasLong = (p) => `${clock((p.seconds != null ? p.seconds : 0))} listened to`;
  async function runSound(fileForModel) {
    if (!needAudio()) return; busy = true; render('Starting…'); ctrl = new AbortController();
    try {
      if (!S.yam) {
        let buf = fileForModel || await getYamnetBuffer(t => setMsg(t));
        S.yam = await loadYamnet(buf, { onStatus: t => setMsg(t) });
        if (fileForModel) await keepYamnet(fileForModel);
      }
      const r = await scanSound(S.file, S.yam, { signal: ctrl.signal, onProgress: p => setMsg(`Listening… ${Math.round(p.frac * 100)}% (${clock(p.seconds)} of the match)`) });
      if (!ctrl.signal.aborted) { m.sound = { hop: r.hop, cheer: r.cheer, applause: r.applause, crowd: r.crowd, shout: r.shout, whistle: r.whistle, speech: r.speech }; await DB.saveMatch(m); }
      busy = false; render(ctrl.signal.aborted ? 'Stopped.' : 'Done. Cheering and whistles recorded.');
    } catch (err) {
      busy = false; S.yam = null;
      if ((err.message || '').startsWith('NEEDFILE')) {
        render(err.message.replace('NEEDFILE: ', ''));
        const sf = $('#sfSound'); sf.textContent = 'Choose yamnet.onnx';
        sf.onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.onnx'; i.onchange = async () => { if (i.files[0]) runSound(await i.files[0].arrayBuffer()); }; i.click(); };
      } else render(err.message || 'The sound scan failed');
    }
  }
  async function runSpeech() {
    if (!needAudio()) return; busy = true; render('Starting…'); ctrl = new AbortController();
    try {
      if (!S.asr) S.asr = await loadWhisper({ onStatus: t => setMsg(t), onProgress: f => setMsg(`Downloading the speech model… ${Math.round(f * 100)}%`) });
      const r = await scanSpeech(S.file, S.asr, { signal: ctrl.signal, onProgress: p => setMsg(`Listening for words… ${Math.round(p.frac * 100)}% · ${p.hits} mention${p.hits === 1 ? '' : 's'} of goals so far`) });
      if (!ctrl.signal.aborted) { m.speech = { words: r.words, hits: r.hits }; await DB.saveMatch(m); }
      busy = false; render(ctrl.signal.aborted ? 'Stopped.' : (r.words < 30 ? 'Done, but hardly any speech was heard, so this clue will not help on this recording.' : 'Done.'));
    } catch (err) { busy = false; S.asr = null; render(err.message || 'The speech scan failed'); }
  }
  async function runGemini() {
    readG();
    if (!haveFile(m)) return toast('Attach the match video first');
    if (!G.key) return setMsg('Paste your Gemini key first.');
    if (!G.ok) return setMsg('Tick the box to say you are happy for the video to be uploaded to Google.');
    let dur = m.duration || (m.video && m.video.duration) || 0;
    if (!dur) { try { dur = (await probeVideo(S.file)).duration; } catch (_) {} }
    if (!dur || !isFinite(dur)) return setMsg('I could not work out how long the video is.');
    busy = true; render('Checking the key\u2026'); ctrl = new AbortController(); let up = null;
    try {
      if (!G.models) { G.models = await listModels(G.key, { signal: ctrl.signal }); }
      if (!G.models.some(x => x.name === G.model)) G.model = lsGet('ps_gemini_model', '') && G.models.some(x => x.name === lsGet('ps_gemini_model', '')) ? lsGet('ps_gemini_model', '') : G.models[0].name;
      lsSet('ps_gemini_key', G.rem ? G.key : ''); lsSet('ps_gemini_model', G.model);
      setMsg('Uploading the video to Google\u2026 0%');
      up = await uploadVideo(G.key, S.file, { signal: ctrl.signal, onProgress: f => setMsg(`Uploading the video to Google\u2026 ${Math.round(f * 100)}% (a 200 MB match can take several minutes)`) });
      const r = await askGoals(G.key, G.model, up, { us: m.us, them: m.them, duration: dur, signal: ctrl.signal, onProgress: p => setMsg(p.text) });
      m.gemini = { model: G.model, at: Date.now(), goals: r.goals.map(g => ({ t: g.t, side: sideFromText(m, g.team), conf: g.conf, note: g.note })) };
      await DB.saveMatch(m);
      busy = false; render(`Done. Gemini listed ${r.goals.length} goal${r.goals.length === 1 ? '' : 's'}: ${r.goals.map(g => clock(g.t)).join(', ') || 'none'}. Now press Find the goals.`);
    } catch (err) {
      busy = false; if (err.status === 400 || err.status === 401 || err.status === 403) G.models = null;
      render(err.message || 'Gemini did not work');
    } finally { if (up) deleteUpload(G.key, up.name); }
  }
  function combine() {
    const a = parseInt($('#sfUs').value, 10), b = parseInt($('#sfThem').value, 10);
    const known = a >= 0 && b >= 0 ? a + b : null;
    if (known === 0) return setMsg('0–0, so there are no goals to find.');
    if (known != null) { m.finalUs = a; m.finalThem = b; }
    const { ev, notes } = evidenceFor(m, known);
    if (!ev.length) return setMsg('There is no evidence yet. Run Scan match, the ball tracker, or one of the Listen buttons.');
    cands = fuse(ev, { n: known });
    picks = new Set(); cands.forEach((c, i) => { if (c.picked) picks.add(i); });
    const names = { crowd: 'crowd noise', board: 'scoreboard', ball: 'ball', cheer: 'cheering', speech: 'speech', gemini: 'Gemini' };
    setMsg(`Used: ${Object.keys(notes).map(k => names[k] || k).join(', ')}.${known != null ? ` Kept the ${known} most likely, for a final score of ${a}–${b}.` : ' Without the final score it keeps only the strongest.'}`);
    const rows = cands.slice().map((c, i) => [c, i]).sort((x, y) => (y[0].picked - x[0].picked) || (x[0].time - y[0].time));
    $('#sfList').innerHTML = rows.map(([c, i]) => `<label class="cand big"><input type="checkbox" data-i="${i}" ${picks.has(i) ? 'checked' : ''}>
      <b>${clock(c.time)}</b><span class="chips">${c.evidence.map(e => `<i class="chip">${esc(e.label)}</i>`).join('')}</span><em>${Math.round(c.score * 100)}%</em></label>`).join('');
    $$('#sfList input').forEach(cb => cb.onchange = () => { cb.checked ? picks.add(+cb.dataset.i) : picks.delete(+cb.dataset.i); upd(); });
    $('#sfGo').textContent = 'Work it out again'; upd();
  }
  const upd = () => { const b = $('#sfAdd'); b.hidden = false; b.disabled = !picks.size; b.textContent = picks.size ? `Add ${picks.size} goal${picks.size === 1 ? '' : 's'} to the match` : 'Tick the goals to add';
    b.onclick = async () => {
      if (!m.events) m.events = [];
      if (!m.duration) { m.duration = (m.video && m.video.duration) || 0; m.half = m.halfTime || m.duration / 2; }
      [...picks].sort((x, y) => cands[x].time - cands[y].time).forEach(i => addGoalAt(m, cands[i].time, cands[i].side));
      await DB.saveMatch(m); scrim.remove(); finishEventEdit(m); toast('Added. Check each one, then tap who scored.'); go(`#/match/${m.id}/moments`);
    }; };
  render('');
}

// ------------------------------------------------------------ ball tracker (beta)
const KEEP = 'pitchside-keep', MODEL_KEY = '/__pitchside_ball_model';
async function saveBallModel(name, buffer) {
  try { const c = await caches.open(KEEP); await c.put(MODEL_KEY, new Response(buffer, { headers: { 'x-name': name } })); } catch (_) {}
}
async function restoreBallModel() {
  if (S.ball.name) return;
  try {
    const c = await caches.open(KEEP), r = await c.match(MODEL_KEY);
    if (r) { S.ball.name = r.headers.get('x-name') || 'ball model'; S.ball.buffer = await r.arrayBuffer(); S.ball.sess = null; }
  } catch (_) {}
}
function ballStateText() {
  if (!S.ball.name) return 'No model loaded yet.';
  const mb = S.ball.buffer ? ` (${(S.ball.buffer.byteLength / 1048576).toFixed(0)} MB)` : '';
  return `Model: ${esc(S.ball.name)}${mb}${S.ball.sess ? ` · ready, running on ${S.ball.sess.ep === 'webgpu' ? 'your graphics chip' : 'the CPU (slow)'}` : ''}. Kept on this device.`;
}
async function chooseBallModel(m, f) {
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    if (buf.byteLength < 100000) throw new Error('That file is too small to be a model');
    S.ball = { name: f.name, buffer: buf, sess: null };
    await saveBallModel(f.name, buf);
    toast('Model loaded: ' + f.name); setupView(m);
  } catch (err) { toast(err.message || 'Could not read that file'); }
}
function ballEta(m) {
  const el = $('#ballEta'); if (!el) return;
  const d = m.video && m.video.duration;
  el.textContent = d ? `${Math.round(d * S.ballFps).toLocaleString('en-GB')} frames to check. Pitchside times itself and tells you how long it will take.` : '';
}
async function runBallScan(m) {
  if (!haveFile(m)) return needVideo();
  if (!S.ball.buffer) return toast('Choose the ball model file first');
  const ctrl = new AbortController(); let discard = false;
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-label="Tracking the ball"><h4>Tracking the ball</h4>
    <div class="bar"><i id="bbar" style="width:0%"></i></div><p class="note" id="btxt">Loading the model&hellip;</p>
    <p class="note" id="bnote"></p>
    <button id="bstop" class="primary" hidden>Stop here and use what it has found</button><button class="cancel" id="bcancel">Cancel</button></div>`;
  document.body.appendChild(scrim);
  $('#bcancel').onclick = () => { discard = true; ctrl.abort(); scrim.remove(); };
  $('#bstop').onclick = () => ctrl.abort();
  try {
    if (!S.ball.sess) S.ball.sess = await loadBallSession(new Uint8Array(S.ball.buffer), { onStatus: t => { const e = $('#btxt'); if (e) e.textContent = t; } });
    const sess = S.ball.sess;
    if ($('#bnote')) $('#bnote').textContent = sess.ep === 'webgpu' ? 'Keep this tab in front. It is using your graphics chip.' : 'Your browser has no WebGPU, so this is running on the CPU and will be very slow. Chrome or Edge on a recent laptop is better.';
    $('#bstop').hidden = false;
    const res = await scanBall(S.file, sess, {
      sampleFps: S.ballFps, signal: ctrl.signal,
      onProgress: p => {
        if (!$('#bbar')) return;
        $('#bbar').style.width = Math.round(p.frac * 100) + '%';
        const left = p.etaSec != null ? ` · about ${Math.max(1, Math.ceil(p.etaSec / 60))} min left` : '';
        $('#btxt').textContent = p.hidden ? 'Paused: come back to this tab and it carries on.'
          : `${clock(p.t)} of ${clock(p.duration)} · ball seen ${p.sightings} times in ${p.samples} frames${left}`;
      },
    });
    scrim.remove();
    if (discard) return;
    if (res.rows.length >= 20) { m.ballTrack = { fps: S.ballFps, duration: res.duration, rows: res.rows.map(r => [+r[0].toFixed(2), +r[1].toFixed(4), +r[2].toFixed(4), +r[3].toFixed(2)]) }; await DB.saveMatch(m); }
    if (res.rows.length < 20) return toast('The ball was hardly seen, so this model may not suit this footage. Try Thorough, or a different model.');
    ballReview(m, res);
  } catch (err) {
    scrim.remove();
    if (!discard) toast(err.message || 'Ball tracking failed');
  }
}
function ballReview(m, res) {
  const pts = cleanTrack(res.rows, res.duration);
  if (pts.length < 20) return toast('Not enough ball sightings to work with');
  const auto = suggestZones(pts); let zones = { left: auto.left.slice(), right: auto.right.slice(), centre: auto.centre.slice() };
  let cands = [], armed = null, drag = null; const pick = new Set();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet wide" role="dialog" aria-label="Goals found"><h4>${res.partial ? 'Stopped early at ' + clock(res.coveredTo) : 'Ball tracking finished'}</h4>
    <p class="note" id="rvSum"></p>
    <div class="markwrap"><canvas id="rvCv"></canvas></div>
    <p class="note">Yellow dots are where the ball was seen. The three boxes should sit on the left goal, the right goal and the centre spot. If one is wrong, tap its button then drag a new box on the picture.</p>
    <div class="zbtns"><button data-z="left">Left goal</button><button data-z="centre">Centre spot</button><button data-z="right">Right goal</button><button data-z="auto">Reset</button></div>
    <div id="rvList"></div>
    <button class="primary wide" id="rvAdd">Add to the match</button><button class="cancel" id="rvClose">Close</button></div>`;
  document.body.appendChild(scrim);
  const cv = $('#rvCv'), ctx = cv.getContext('2d'), vid = document.createElement('video');
  vid.muted = true; vid.preload = 'auto'; vid.src = S.fileUrl;
  const COL = { left: '#34C6F4', right: '#34C6F4', centre: '#E64B9B' }, NAME = { left: 'left goal', right: 'right goal', centre: 'centre spot' };
  const draw = () => {
    if (!cv.width) return;
    ctx.fillStyle = '#1b2a22'; ctx.fillRect(0, 0, cv.width, cv.height);
    if (vid.readyState >= 2) ctx.drawImage(vid, 0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(241,181,28,.5)';
    for (const p of pts) ctx.fillRect(p[1] * cv.width - 1.5, p[2] * cv.height - 1.5, 3, 3);
    for (const k of ['left', 'right', 'centre']) {
      const z = (drag && drag.k === k) ? drag.z : zones[k];
      ctx.lineWidth = 3; ctx.strokeStyle = COL[k]; ctx.strokeRect(z[0] * cv.width, z[2] * cv.height, (z[1] - z[0]) * cv.width, (z[3] - z[2]) * cv.height);
      ctx.fillStyle = COL[k]; ctx.font = '600 14px system-ui'; ctx.fillText(NAME[k], z[0] * cv.width + 4, z[2] * cv.height + 16);
    }
  };
  const recalc = () => {
    cands = findCandidates(pts, zones, { sampleFps: S.ballFps });
    pick.clear(); cands.forEach((c, i) => { if (c.restart) pick.add(i); });
    const likely = cands.filter(c => c.restart).length;
    $('#rvSum').textContent = `Likely goals found: ${likely}${m.finalUs != null ? ` (you told me the score was ${m.finalUs}–${m.finalThem}, so ${m.finalUs + m.finalThem} goals)` : ''}. Other times the ball reached a goal but no kick-off followed: ${cands.length - likely}.`;
    $('#rvList').innerHTML = cands.length ? cands.map((c, i) => `<label class="cand"><input type="checkbox" data-i="${i}" ${pick.has(i) ? 'checked' : ''}>
      <b>${clock(c.time)}</b><span>${c.end} goal</span><em>${c.restart ? 'Kick-off at ' + clock(c.restartAt) : 'maybe (shot or save?)'}</em></label>`).join('')
      : '<p class="note">No goal-like moments found. Check the boxes above.</p>';
    $$('#rvList input').forEach(cb => cb.onchange = () => { cb.checked ? pick.add(+cb.dataset.i) : pick.delete(+cb.dataset.i); upd(); });
    upd(); draw();
  };
  const upd = () => { const b = $('#rvAdd'); b.disabled = !pick.size; b.textContent = pick.size ? `Add ${pick.size} goal${pick.size === 1 ? '' : 's'} to the match` : 'Tick the goals to add'; };
  vid.onloadedmetadata = () => { cv.width = 720; cv.height = Math.round(720 * vid.videoHeight / vid.videoWidth); vid.currentTime = Math.min(vid.duration * 0.3, 600); draw(); };
  vid.onseeked = draw;
  const pt = e => { const r = cv.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  cv.style.touchAction = 'none';
  cv.onpointerdown = e => { if (!armed) return; cv.setPointerCapture(e.pointerId); const p = pt(e); drag = { k: armed, x0: p.x, y0: p.y, z: [p.x, p.x, p.y, p.y] }; };
  cv.onpointermove = e => { if (!drag) return; const p = pt(e); drag.z = [Math.min(drag.x0, p.x), Math.max(drag.x0, p.x), Math.min(drag.y0, p.y), Math.max(drag.y0, p.y)]; draw(); };
  cv.onpointerup = () => {
    if (!drag) return;
    if (drag.z[1] - drag.z[0] > 0.01 && drag.z[3] - drag.z[2] > 0.01) { zones[drag.k] = drag.z; if (m.ballTrack) { m.ballTrack.zones = zones; DB.saveMatch(m); } }
    drag = null; armed = null; $$('.zbtns button').forEach(b => b.classList.remove('on')); recalc();
  };
  $$('.zbtns button').forEach(b => b.onclick = () => {
    if (b.dataset.z === 'auto') { zones = { left: auto.left.slice(), right: auto.right.slice(), centre: auto.centre.slice() }; armed = null; $$('.zbtns button').forEach(x => x.classList.remove('on')); return recalc(); }
    armed = armed === b.dataset.z ? null : b.dataset.z; $$('.zbtns button').forEach(x => x.classList.toggle('on', x.dataset.z === armed));
  });
  const close = () => { scrim.remove(); vid.removeAttribute('src'); vid.load(); };
  $('#rvClose').onclick = close;
  $('#rvAdd').onclick = async () => {
    if (!m.events) m.events = [];
    if (!m.duration) { m.duration = res.duration || m.video.duration; m.half = m.halfTime || m.duration / 2; }
    m.ballTrack = { fps: S.ballFps, duration: res.duration, zones, rows: res.rows.map(r => [+r[0].toFixed(2), +r[1].toFixed(4), +r[2].toFixed(4), +r[3].toFixed(2)]) };
    [...pick].sort((a, b) => cands[a].time - cands[b].time).forEach(i => addGoalAt(m, cands[i].time, null));
    await DB.saveMatch(m); close(); finishEventEdit(m);
    toast('Added. Now tap who scored on each goal.'); go(`#/match/${m.id}/moments`);
  };
  recalc();
}

// ------------------------------------------------------------ scoreboard marking
function markScoreArea(m, done) {
  if (!haveFile(m)) return needVideo();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet wide" role="dialog" aria-label="Mark the score"><h4>Mark the score on the video</h4>
    <p class="note" id="markStep"></p>
    <div class="markwrap"><canvas id="markCv"></canvas></div>
    <label class="fld"><span>Pick a moment where the scoreboard is showing</span><input type="range" id="markT" min="0" max="1000" value="150"></label>
    <label class="fld"><span>The first score number belongs to</span><select id="markWho"><option value="us">${esc(m.us)}</option><option value="them">${esc(m.them)}</option></select></label>
    <button class="primary wide" id="markSave" disabled>Save</button><button class="ghost wide" id="markRedo">Start again</button><button class="cancel" id="markCancel">Cancel</button></div>`;
  document.body.appendChild(scrim);
  const cv = $('#markCv'), ctx = cv.getContext('2d'), vid = document.createElement('video');
  vid.muted = true; vid.preload = 'auto'; vid.src = S.fileUrl;
  const boxes = { home: null, away: null }; let step = 0, drag = null;
  const msg = () => $('#markStep').innerHTML = step === 0 ? 'Step 1 of 2: drag a box tightly around the <b>first team’s score number</b> only (not the clock).'
    : step === 1 ? 'Step 2 of 2: now drag a box around the <b>second team’s score number</b>.' : 'Both marked. Check the boxes cover just the numbers, then Save.';
  const draw = () => {
    if (vid.readyState >= 2) ctx.drawImage(vid, 0, 0, cv.width, cv.height);
    for (const [k, c] of [['home', '#F1B51C'], ['away', '#34C6F4']]) {
      const b = (drag && drag.k === k) ? drag.r : boxes[k]; if (!b) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = c; ctx.strokeRect(b.x * cv.width, b.y * cv.height, b.w * cv.width, b.h * cv.height);
    }
  };
  const seek = () => { const t = (+$('#markT').value / 1000) * (m.video.duration || vid.duration || 0); vid.currentTime = Math.max(0, Math.min(t, (vid.duration || t) - 0.5)); };
  vid.onloadedmetadata = () => { cv.width = 720; cv.height = Math.round(720 * vid.videoHeight / vid.videoWidth); seek(); };
  vid.onseeked = draw;
  $('#markT').oninput = seek;
  const pt = e => { const r = cv.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  cv.style.touchAction = 'none';
  cv.onpointerdown = e => { if (step > 1) return; cv.setPointerCapture(e.pointerId); const p = pt(e); drag = { k: step === 0 ? 'home' : 'away', x0: p.x, y0: p.y, r: { x: p.x, y: p.y, w: 0, h: 0 } }; };
  cv.onpointermove = e => { if (!drag) return; const p = pt(e); drag.r = { x: Math.min(drag.x0, p.x), y: Math.min(drag.y0, p.y), w: Math.abs(p.x - drag.x0), h: Math.abs(p.y - drag.y0) }; draw(); };
  cv.onpointerup = () => {
    if (!drag) return;
    if (drag.r.w > 0.005 && drag.r.h > 0.008) { boxes[drag.k] = drag.r; step++; msg(); $('#markSave').disabled = step < 2; }
    drag = null; draw();
  };
  $('#markRedo').onclick = () => { boxes.home = boxes.away = null; step = 0; $('#markSave').disabled = true; msg(); draw(); };
  const close = () => { scrim.remove(); vid.removeAttribute('src'); vid.load(); };
  $('#markCancel').onclick = close;
  $('#markSave').onclick = async () => { m.scoreBoxes = { home: boxes.home, away: boxes.away }; m.scoreHome = $('#markWho').value; await DB.saveMatch(m); close(); toast('Score area saved'); if (done) done(); };
  msg();
}
function scoreCard(m) {
  if (!m.scoreEvents) return '';
  const ev = m.scoreEvents, us = ev.filter(e => e.side === 'us').length, them = ev.length - us;
  return `<section class="card" id="scoreCard"><h3>Scoreboard changes</h3>
    <p class="note">${ev.length ? `The scoreboard changed ${ev.length} time${ev.length === 1 ? '' : 's'}: ${esc(m.us)} ${us}, ${esc(m.them)} ${them}.` : 'No score changes were seen in the marked area.'}
    ${m.scoreNoisy ? ' The marked area kept changing, so it may include the clock. Mark just the numbers and scan again.' : ''}</p>
    ${ev.length ? `<p class="note">${ev.map(e => `${clock(e.time)} ${esc(e.side === 'us' ? m.us : m.them)}`).join(' · ')}</p><button class="primary wide" id="useScore">Use these as the goals</button>` : ''}</section>`;
}

function loadModel() { try { const j = JSON.parse(lsGet('ps_goal_model', 'null')); return j && j.w && j.w.length === 6 ? j : null; } catch (_) { return null; } }
function teachFromMatch(m) {
  const goals = goalsOf(m).filter(e => e.manual || e.fromScoreboard);
  if (!m.raw || !m.raw.loud) return toast('This match has no audio signals to learn from');
  if (goals.length < 2) return toast('Confirm at least 2 goals first (scoreboard, typed times or Goal here)');
  const r = trainGoalModel(m.raw, m.duration, goals.map(e => e.time), { sampleFps: 2, prev: loadModel() });
  if (!r) return toast('Not enough data to learn from');
  lsSet('ps_goal_model', JSON.stringify(r.model)); updateTeachInfo(m);
  toast(`Learned from ${goals.length} goals. On this match it now finds ${r.hit} of ${r.total}.`);
}
function updateTeachInfo(m) { const el = $('#teachInfo'); if (!el) return; const md = loadModel(); el.textContent = md ? `Pitchside has learned from ${md.n} goals so far. "Find goals" uses that.` : 'Not taught yet. "Find goals" uses a basic guess.'; }
function goalBox(m) {
  return `<section class="card goalbox" id="goalBox"><h3>Find the goals</h3>
    <p class="note">Enter the final score and Pitchside picks the most goal-like moments (a long roar, then a lull and a restart whistle). You then just tap who scored.</p>
    <div class="fs"><label>${esc(m.us)}<input id="fsUs" type="number" inputmode="numeric" min="0" max="30" value="${m.finalUs ?? ''}"></label>
      <span class="dash">&ndash;</span>
      <label>${esc(m.them)}<input id="fsThem" type="number" inputmode="numeric" min="0" max="30" value="${m.finalThem ?? ''}"></label></div>
    <button class="primary wide" id="findGoals">Find goals</button><p class="note" id="goalStatus"></p>
    <button class="ghost wide" id="teach">Teach Pitchside from this match's confirmed goals</button><p class="note" id="teachInfo"></p></section>`;
}
function updateGoalStatus(m) {
  const el = $('#goalStatus'); if (!el) return;
  const g = m.events.filter(e => e.type === 'goal'), us = g.filter(e => e.side === 'us').length, them = g.filter(e => e.side === 'them').length;
  const open = g.filter(e => !e.side).length;
  if (!g.length) { el.textContent = ''; return; }
  const fin = m.finalUs != null && m.finalThem != null ? ` (final score ${m.finalUs}\u2013${m.finalThem})` : '';
  el.textContent = `Goals marked: ${m.us} ${us}, ${m.them} ${them}${open ? ` · ${open} still to assign` : ''}${fin}`;
}
function runFindGoals(m) {
  const a = parseInt($('#fsUs').value, 10), b = parseInt($('#fsThem').value, 10);
  if (!(a >= 0) || !(b >= 0)) return toast('Enter the final score first');
  if (a + b === 0) return toast('0\u20130, so no goals to find');
  m.finalUs = a; m.finalThem = b;
  // clear earlier guesses the user has not confirmed
  m.events = m.events.filter(e => !(e.guess && e.created && !e.side));
  for (const e of m.events) if (e.guess && !e.side) { e.type = null; e.guess = false; }
  const cands = findGoals(m.raw, m.duration, { n: a + b, halfTime: m.halfTime, sampleFps: 2, model: loadModel() });
  let id = Math.max(0, ...m.events.map(x => x.id));
  for (const c of cands) {
    const near = m.events.find(e => Math.abs(e.time - c.time) < 25);
    if (near) { if (!near.type || near.guess) { near.type = 'goal'; near.guess = true; near.label = 'Likely goal'; near.time = c.time; near.start = Math.max(0, c.time - 15); near.end = Math.min(m.duration, c.time + 12); } }
    else m.events.push({ id: ++id, time: c.time, start: Math.max(0, c.time - 15), end: Math.min(m.duration, c.time + 12), score: c.score, label: 'Likely goal', type: 'goal', side: null, guess: true, created: true });
  }
  m.events.sort((x, y) => x.time - y.time); m.events.forEach((e, i) => e.id = i + 1);
  DB.saveMatch(m); renderMoments(m); updateGoalStatus(m);
  toast(`Marked ${cands.length} likely goals. Tap who scored on each.`);
  const first = $('.mom.tagged'); if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function momentsTab(m) {
  const has = haveFile(m);
  $('#tabBody').innerHTML = `
    <section class="player" id="playerWrap">
      ${has ? `<video id="vid" src="${S.fileUrl}" controls playsinline preload="metadata"></video>
        <div class="reelbar" id="reelbar" hidden><button data-r="prev" aria-label="Previous">&#8249;</button><span id="reelTxt"></span><button data-r="next" aria-label="Next">&#8250;</button><button data-r="stop" class="stop">Stop</button></div>`
        : `<div class="attach"><p>Attach the match video to watch these moments.</p><label class="btn primary"><input id="vfile" type="file" accept="video/*" hidden>Choose video</label></div>`}
    </section>
    <div class="actions">
      <button class="ghost" id="addMoment" ${has ? '' : 'disabled'}>+ Moment at <b id="addAt">0:00</b></button>
      <button class="primary sm" id="playReel">Play highlights</button></div>
    <div class="actions quick"><button class="ghost" id="goalUs" ${has ? '' : 'disabled'}>Goal here: ${esc(m.us)}</button>
      <button class="ghost" id="goalThem" ${has ? '' : 'disabled'}>Goal here: ${esc(m.them)}</button></div>
    ${highlightCards(m)}
    ${scoreCard(m)}
    <div class="actions"><button class="ghost" id="smartOpen">Smart goal finder (combine all clues)</button></div>
    ${m.raw ? goalBox(m) : ''}
    ${m.raw ? `<div class="fld inline"><span>Sensitivity</span>${seg('sensSeg', [['fewer', 'Fewer'], ['normal', 'Normal'], ['more', 'More']], m.sens || 'normal')}</div>` : ''}
    <div id="momentList" class="moms"></div>`;
  renderMoments(m); updateGoalStatus(m); wireHighlightCards(m);
  const fg = $('#findGoals'); if (fg) fg.onclick = () => runFindGoals(m);
  const so = $('#smartOpen'); if (so) so.onclick = () => smartFinder(m);
  const th = $('#teach'); if (th) th.onclick = () => teachFromMatch(m); updateTeachInfo(m);
  const us = $('#useScore'); if (us) us.onclick = () => {
    m.events = m.events.filter(e => !(e.guess && !e.side));
    for (const e of m.scoreEvents) { const g = addGoalAt(m, e.time, e.side); g.fromScoreboard = true; g.label = 'Goal (scoreboard)'; }
    m.finalUs = m.scoreEvents.filter(e => e.side === 'us').length; m.finalThem = m.scoreEvents.length - m.finalUs;
    finishEventEdit(m); toast(`Marked ${m.scoreEvents.length} goals from the scoreboard`);
  };
  const vf = $('#vfile'); if (vf) vf.onchange = e => attachFile(m, e.target.files[0], () => momentsTab(m));
  const list = $('#momentList');
  list.onclick = ev => {
    const card = ev.target.closest('.mom'); if (!card) return;
    const e = m.events.find(x => x.id === +card.dataset.id); if (!e) return;
    const sideBtn = ev.target.closest('[data-side]'), actEl = ev.target.closest('[data-act]');
    if (sideBtn) { e.side = sideBtn.dataset.side; if (e.guess) e.label = 'Goal'; DB.saveMatch(m); card.outerHTML = momCard(e, S.clipId === e.id); updateGoalStatus(m); updateVidInfo(m); return; }
    if (!actEl) return;
    if (actEl.dataset.act === 'play') { S.reel = null; updateReelBar(); playClip(e); }
    else if (actEl.dataset.act === 'skip') {
      if (e.type === 'skip') { e.type = e.prevType || null; e.prevType = null; } else { e.prevType = e.type; e.type = 'skip'; }
      DB.saveMatch(m); renderMoments(m);
    }
  };
  list.onchange = ev => {
    if (!ev.target.matches('select[data-act="type"]')) return;
    const card = ev.target.closest('.mom'), e = m.events.find(x => x.id === +card.dataset.id);
    e.type = ev.target.value || null;
    if (e.type && !e.side) e.side = 'us';
    if (!e.type) e.side = null;
    DB.saveMatch(m); renderMoments(m);
  };
  $('#playReel').onclick = () => {
    if (!haveFile(m)) return needVideo();
    const rl = reelList(m); if (!rl.length) return toast('Nothing to play yet');
    S.reel = { list: rl, i: 0 }; playClip(rl[0]); updateReelBar();
  };
  const quick = side => () => { const v = $('#vid'); if (!v) return needVideo(); addGoalAt(m, v.currentTime, side); finishEventEdit(m); toast(`Goal marked at ${clock(v.currentTime)} for ${side === 'us' ? m.us : m.them}`); };
  $('#goalUs').onclick = quick('us'); $('#goalThem').onclick = quick('them');
  $('#addMoment').onclick = () => {
    const v = $('#vid'); if (!v) return needVideo();
    const t = v.currentTime;
    const e = { id: Math.max(0, ...m.events.map(x => x.id)) + 1, time: t, start: Math.max(0, t - 10), end: Math.min(m.duration, t + 6), score: null, label: 'Added by you', type: null, side: null, manual: true };
    m.events.push(e); m.events.sort((a, b) => a.time - b.time); DB.saveMatch(m); renderMoments(m);
    toast(`Added a moment at ${clock(t)}`);
  };
  wireSeg('sensSeg', k => { applySensitivity(m, k); DB.saveMatch(m); renderMoments(m); toast(`${m.events.filter(e => e.type !== 'skip').length} moments`); });
  const pb = $('#playerWrap'); if (pb) pb.onclick = ev => {
    const r = ev.target.closest('[data-r]'); if (!r) return;
    if (r.dataset.r === 'next') nextReel(1); else if (r.dataset.r === 'prev') nextReel(-1); else stopReel();
  };
  const v = $('#vid');
  if (v) {
    v.addEventListener('seeked', () => { if (S.ourSeek) { S.ourSeek = false; return; } S.clipEnd = null; if (S.reel) { S.reel = null; updateReelBar(); } });
    S.tick = setInterval(() => {
      const at = $('#addAt'); if (at) at.textContent = clock(v.currentTime);
      if (S.clipEnd != null && v.currentTime >= S.clipEnd - 0.05) { if (S.reel) nextReel(); else { v.pause(); S.clipEnd = null; } }
    }, 120);
    if (S.pendingPlay != null) { const e = m.events.find(x => x.id === S.pendingPlay); S.pendingPlay = null; if (e) playClip(e); }
  }
}

// ============================================================ go
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost','127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
