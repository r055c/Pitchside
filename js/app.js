import * as DB from './db.js';
import { scanVideo, probeVideo, processSignals, findGoals } from './analysis.js';

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
const S = { file: null, fileUrl: null, fileFor: null, rate: 4, scanning: null, reel: null, clipEnd: null, clipId: null, tick: null, ourSeek: false, pendingPlay: null };
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
    ...(m.events ? [{ label: 'Export match data (.json)', fn: () => exportMatch(m) }, { label: 'Copy match data (if export is blocked)', fn: () => copyMatch(m) }] : []),
    ...(m.events && haveFile(m) ? [{ label: 'Scan again', fn: () => { m.events = null; m.curves = null; m.raw = null; DB.saveMatch(m).then(() => go(`#/match/${m.id}`)); } }] : []),
    { label: 'Delete this match', danger: true, fn: async () => { if (confirm('Delete this match and its tags from this device?')) { await DB.deleteMatch(m.id); toast('Match deleted'); go('#/'); } } },
  ]);
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
      rate: S.rate, sampleFps: 2, signal: ctrl.signal,
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
    m.frameCoverage = res.frameCoverage; await DB.saveMatch(m);
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
  const U = mean(m.curves.us), T = mean(m.curves.them), upct = Math.round(100 * U / ((U + T) || 1));
  const pct = (n, d) => d ? Math.round(100 * n / d) + '%' : '–';
  $('#tabBody').innerHTML = `
    ${m.partialTo ? `<div class="notice">The scan stopped early at ${clock(m.partialTo)}, so later moments aren't covered.</div>` : ''}
    <section class="score"><div class="side us"><b>${st.us.goals}</b><span>${esc(m.us)}</span></div><div class="dash">–</div><div class="side them"><b>${st.them.goals}</b><span>${esc(m.them)}</span></div></section>
    ${tagged ? '' : `<div class="notice">Nothing tagged yet. <a href="#/match/${m.id}/moments">Review the ${total} moments</a> to fill in the score and stats.</div>`}
    <section class="card"><div class="cardhd"><h3>Match flow</h3><div class="legend"><span class="us">${esc(m.us)}</span><span class="them">${esc(m.them)}</span></div></div>
      <div id="chart" class="chart">${flowChart(m)}</div>
      <div class="share"><span class="us" style="width:${upct}%">${upct}%</span><span class="them" style="width:${100 - upct}%">${100 - upct}%</span></div>
      <p class="note">Estimated share of the play, from camera movement and crowd noise. Tap a marker to watch it.</p></section>
    <section class="card"><h3>Head to head</h3>
      ${h2hRow('Goals', st.us.goals, st.them.goals)}${h2hRow('Shots', st.us.shots, st.them.shots)}${h2hRow('On target', st.us.sot, st.them.sot)}
      ${h2hRow('Corners', st.us.corners, st.them.corners)}${h2hRow('Saves', st.us.saves, st.them.saves)}${h2hRow('Fouls', st.us.fouls, st.them.fouls)}
      <div class="derived"><div><b>${pct(st.us.goals, st.us.shots)}</b><span>Our conversion</span></div><div><b>${pct(st.us.sot, st.us.shots)}</b><span>Our accuracy</span></div>
      <div><b>${pct(st.them.goals, st.them.shots)}</b><span>Their conversion</span></div></div>
      <p class="note">Built from the ${tagged} of ${total} moments you've tagged. A save counts as a shot on target for the other side.</p></section>
    <a class="primary" href="#/match/${m.id}/moments">${tagged < total ? 'Review moments' : 'Play highlights'}</a>`;
  $('#chart').onclick = ev => {
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

function goalBox(m) {
  return `<section class="card goalbox" id="goalBox"><h3>Find the goals</h3>
    <p class="note">Enter the final score and Pitchside picks the most goal-like moments (a long roar, then a lull and a restart whistle). You then just tap who scored.</p>
    <div class="fs"><label>${esc(m.us)}<input id="fsUs" type="number" inputmode="numeric" min="0" max="30" value="${m.finalUs ?? ''}"></label>
      <span class="dash">&ndash;</span>
      <label>${esc(m.them)}<input id="fsThem" type="number" inputmode="numeric" min="0" max="30" value="${m.finalThem ?? ''}"></label></div>
    <button class="primary wide" id="findGoals">Find goals</button><p class="note" id="goalStatus"></p></section>`;
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
  const cands = findGoals(m.raw, m.duration, { n: a + b, halfTime: m.halfTime, sampleFps: 2 });
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
    ${m.raw ? goalBox(m) : ''}
    ${m.raw ? `<div class="fld inline"><span>Sensitivity</span>${seg('sensSeg', [['fewer', 'Fewer'], ['normal', 'Normal'], ['more', 'More']], m.sens || 'normal')}</div>` : ''}
    <div id="momentList" class="moms"></div>`;
  renderMoments(m); updateGoalStatus(m);
  const fg = $('#findGoals'); if (fg) fg.onclick = () => runFindGoals(m);
  const vf = $('#vfile'); if (vf) vf.onchange = e => attachFile(m, e.target.files[0], () => momentsTab(m));
  const list = $('#momentList');
  list.onclick = ev => {
    const card = ev.target.closest('.mom'); if (!card) return;
    const e = m.events.find(x => x.id === +card.dataset.id); if (!e) return;
    const sideBtn = ev.target.closest('[data-side]'), actEl = ev.target.closest('[data-act]');
    if (sideBtn) { e.side = sideBtn.dataset.side; if (e.guess) e.label = 'Goal'; DB.saveMatch(m); card.outerHTML = momCard(e, S.clipId === e.id); updateGoalStatus(m); return; }
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
