import * as DB from './db.js';
import { scanVideo, probeVideo, processSignals, findGoals, findScoreChanges, snapToRoar, trainGoalModel } from './analysis.js';
import { makeHighlightsVideo, pickMime, drawStats } from './export.js';
import { loadBallSession, scanBall, hasWebGPU, cleanTrack, suggestZones, findCandidates } from './ball.js';
import { fuse, soundEvents, speechEvents, geminiEvents, SOURCES } from './fuse.js';
import { listModels, uploadVideo, deleteUpload, geminiGoals, geminiMoments, withModels, restingModels, KIND_TEXT } from './gemini.js';
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
const S = { file: null, fileUrl: null, fileFor: null, rate: 4, ballFps: 2, ball: { name: null, buffer: null, sess: null }, scanning: null, reel: null, clipEnd: null, clipId: null, tick: null, ourSeek: false, pendingPlay: null, sel: null, filter: 'all', vt: 0, vtFor: null, refresh: null, onChange: null };
const haveFile = m => S.file && S.fileFor === m.id;
function setFile(m, file) {
  if (S.fileUrl) URL.revokeObjectURL(S.fileUrl);
  S.file = file; S.fileUrl = URL.createObjectURL(file); S.fileFor = m.id;
}
function unmount() {
  clearInterval(S.tick); S.tick = null; S.reel = null; S.clipEnd = null; S.clipId = null; S.refresh = null; S.onChange = null;
  app.classList.remove('wide');
}

// ============================================================ tagging model
const TYPES = {
  goal: { label: 'Goal', ch: 'G' },
  sot: { label: 'Shot on target', ch: 'S' },
  off: { label: 'Shot off target', ch: 'S', hollow: true },
  corner: { label: 'Corner won', ch: 'C' },
  kickin: { label: 'Kick-in', ch: 'K' },
  save: { label: 'Save by keeper', ch: 'K' },
  foul: { label: 'Foul committed', ch: 'F' },
  yellow: { label: 'Yellow card', ch: 'Y' },
  red: { label: 'Red card', ch: 'R' },
  highlight: { label: 'Highlight (no stat)', ch: 'H' },
};
function stats(m) {
  const z = () => ({ goals: 0, shots: 0, sot: 0, corners: 0, kickins: 0, saves: 0, fouls: 0, yellow: 0, red: 0 });
  const r = { us: z(), them: z() };
  for (const e of m.events || []) {
    if (!e.type || e.type === 'skip' || !e.side) continue;
    const a = r[e.side], b = r[e.side === 'us' ? 'them' : 'us'];
    if (e.type === 'goal') { a.goals++; a.shots++; a.sot++; }
    else if (e.type === 'sot') { a.shots++; a.sot++; }
    else if (e.type === 'off') a.shots++;
    else if (e.type === 'corner') a.corners++;
    else if (e.type === 'kickin') a.kickins++;
    else if (e.type === 'save') { a.saves++; b.shots++; b.sot++; }   // a save implies a shot on target by the other side
    else if (e.type === 'foul') a.fouls++;
    else if (e.type === 'yellow') a.yellow++;
    else if (e.type === 'red') a.red++;
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
    row('Corners', st.us.corners, st.them.corners), row('Saves', st.us.saves, st.them.saves), row('Fouls', st.us.fouls, st.them.fouls), row('Kick-ins', st.us.kickins, st.them.kickins), '',
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
  if (parts[0] === 'new') return videoTab(null);
  if (parts[0] === 'help') return help();
  if (parts[0] === 'match' && parts[1]) return matchView(parts[1], parts[2]);
  return home();
}
window.addEventListener('hashchange', route);

// ============================================================ home
async function home() {
  const ms = await DB.allMatches();
  const cards = ms.map(m => {
    const st = stats(m), tagged = taggedCount(m);
    const score = tagged
      ? `<span class="sc"><b class="us">${st.us.goals}</b><i>–</i><b class="them">${st.them.goals}</b></span>` : `<span class="sc dim">${m.events && m.events.length ? 'Not reviewed yet' : 'No highlights yet'}</span>`;
    return `<a class="match" href="#/match/${m.id}">
      <div><b>${esc(m.us)}</b><span class="v">v</span><b>${esc(m.them)}</b><small>${fmtDate(m.date)}${tagged ? ` · ${tagged} highlight${tagged === 1 ? '' : 's'}` : ''}</small></div>${score}</a>`;
  }).join('');
  app.innerHTML = `<header class="top home"><div class="brand"><span class="mark"></span><b>Pitchside</b></div><a class="icon" href="#/help" aria-label="How it works">?</a></header>
  <main class="stack">
    ${ms.length ? `<h2 class="eyebrow">Your matches</h2><div class="list">${cards}</div>` : `
      <section class="hero">
        <h1>Match highlights and stats, free.</h1>
        <p>Pick a match recording. Pitchside finds the goals and other highlights (Gemini AI can watch the whole match for you), you check them, and it builds the stats and a highlights video with a score graphic.</p>
        <ol class="steps"><li><b>Video</b>: choose the match recording</li><li><b>Find highlights</b>: let Gemini or the clues find them</li><li><b>Review &amp; export</b>: check them, then make the video</li></ol>
      </section>`}
    <a class="primary big" href="#/new">New match</a>
  </main>`;
}

// ============================================================ help
function help() {
  app.innerHTML = `${topBar('How it works')}<main class="stack prose">
    <section class="card"><h3>The idea</h3><p>Pitchside has four steps along the top: <b>Video</b>, <b>Find highlights</b>, <b>Review highlights</b> and <b>Export</b>. It builds the stats, the match graphic and the highlights video from the highlights you confirm.</p></section>
    <section class="card"><h3>Using it</h3><ol>
      <li><b>Video</b>: names, date, which way you attack, the final score if you know it, and the match recording.</li>
      <li><b>Find highlights</b>: the best option is <b>Gemini</b>, Google&rsquo;s AI, which watches the match and lists the goals (and, if you ask, shots, saves, corners, kick-ins and fouls). Other options listen to the crowd and whistles, follow the ball or read the scoreboard. Each one can be opened or closed.</li>
      <li><b>Review highlights</b>: watch each one, fix who it was for, trim the clip, or skip it. The Sky-style stats graphic updates as you go.</li>
      <li><b>Export</b>: goals only or all highlights, with or without a scoreboard, then make the video.</li></ol></section>
    <section class="card"><h3>Good to know</h3><ul>
      <li>Your video stays on your computer unless you choose <b>Ask Gemini</b>, which uploads it to Google using your key and deletes it again afterwards.</li>
      <li>Highlights, tags and scan results are saved on this device. After you close the app, pick the video file again to watch clips.</li>
      <li>Gemini&rsquo;s shots, saves, corners, kick-ins and fouls are guesses, so check them in Review.</li>
      <li>Use Chrome or Edge on a computer. The video export plays the clips in real time, so a 3 minute video takes about 3 minutes.</li>
      <li>Works offline once opened (except Gemini).</li></ul></section>
  </main>`;
}

// ============================================================ the match workspace (4 steps)
const TABS = [['video', 'Video'], ['find', 'Find highlights'], ['review', 'Review highlights'], ['export', 'Export']];
const isHl = e => e && e.type !== 'skip' && !!(e.type || e.manual);
const hlList = m => (m.events || []).filter(isHl).sort((a, b) => a.time - b.time);

async function matchView(id, tab) {
  const m = await DB.getMatch(id);
  if (!m) return go('#/');
  if (S.scanning && S.scanning.id === id) return scanView(m);
  if (tab === 'summary' || tab === 'moments') tab = 'review';
  if (!m.events) { m.events = []; }
  if (!m.duration) m.duration = (m.video && m.video.duration) || 0;
  if (!m.half) m.half = m.halfTime || m.duration / 2;
  if (!TABS.some(t => t[0] === tab)) tab = hlList(m).length ? 'review' : (haveFile(m) ? 'find' : 'video');
  await restoreBallModel();
  if (tab === 'video') return videoTab(m);
  if (tab === 'find') return findTab(m);
  if (tab === 'export') return exportTab(m);
  return reviewTab(m);
}

function shell(m, tab, left, right) {
  app.classList.add('wide');
  const n = m ? hlList(m).length : 0;
  app.innerHTML = `<header class="wsnav"><a class="brand" href="#/"><span class="mark"></span><b>Pitchside</b></a>
    <nav aria-label="Steps">${TABS.map(([k, l], i) => {
      const on = k === tab, inner = `<i>${i + 1}</i>${l}${k === 'review' && m ? `<em class="count" id="revCount">${n}</em>` : ''}`;
      return m || k === 'video' ? `<a href="${m ? `#/match/${m.id}/${k}` : '#/new'}" class="${on ? 'on' : ''}" ${on ? 'aria-current="page"' : ''}>${inner}</a>` : `<span class="dis">${inner}</span>`;
    }).join('')}</nav>
    <div class="wsmeta">${m ? `<div><b>${esc(m.us)} v ${esc(m.them)}</b><small>${fmtDate(m.date)}</small></div><button class="icon" id="menuBtn" aria-label="More options">&#8943;</button>` : ''}<a class="icon" href="#/help" aria-label="How it works">?</a></div></header>
    <main class="ws ws-${tab}"><section class="wsL" id="wsL">${left}</section><section class="wsR" id="wsR">${right}</section></main>`;
  if (m) wireMenu(m);
}
function updateCount(m) { const c = $('#revCount'); if (c) c.textContent = hlList(m).length; }

function playerHtml(m, { sb = false } = {}) {
  const has = haveFile(m);
  return `<div id="playerWrap" class="pl">${has ? `<div class="vwrap"><video id="vid" src="${S.fileUrl}" controls playsinline preload="metadata"></video>${sb ? '<div class="sbov" id="sbov"></div>' : ''}</div>
      <div class="reelbar" id="reelbar" hidden><button data-r="prev" aria-label="Previous">&#8249;</button><span id="reelTxt"></span><button data-r="next" aria-label="Next">&#8250;</button><button data-r="stop" class="stop">Stop</button></div>
      <div class="tlbox"><div class="tl" id="tl" aria-label="Timeline. Click to jump."><i class="pos" id="tlpos"></i><div id="tlmarks"></div></div>
        <div class="tlrow"><button class="ghost sm" data-seek="-10">&minus;10 s</button><span id="vtime">0:00</span><button class="ghost sm" data-seek="10">+10 s</button></div></div>`
    : `<div class="attach"><p>Attach the match video to watch it here.</p><label class="btn primary"><input id="vfile" type="file" accept="video/*" hidden>Choose video</label></div>`}</div>`;
}
function drawMarks(m) {
  const el = $('#tlmarks'); if (!el) return;
  const d = m.duration || (m.video && m.video.duration) || 1;
  el.innerHTML = hlList(m).map(e => `<button class="mk2 ${e.side || ''}${e.type === 'goal' ? ' goal' : ''}${S.sel === e.id ? ' sel' : ''}" style="left:${Math.min(100, e.time / d * 100).toFixed(2)}%" data-id="${e.id}" aria-label="${clock(e.time)} ${TYPES[e.type] ? TYPES[e.type].label : 'highlight'}"></button>`).join('');
}
function wirePlayer(m, opts = {}) {
  const vf = $('#vfile'); if (vf) vf.onchange = e => attachFile(m, e.target.files[0], () => go(location.hash));
  const wrap = $('#playerWrap');
  const v = $('#vid');
  if (wrap) wrap.onclick = ev => {
    const r = ev.target.closest('[data-r]');
    if (r) { if (r.dataset.r === 'next') nextReel(1); else if (r.dataset.r === 'prev') nextReel(-1); else stopReel(); return; }
    const sk = ev.target.closest('[data-seek]');
    if (sk && v) { S.reel = null; updateReelBar(); v.currentTime = Math.max(0, v.currentTime + +sk.dataset.seek); }
  };
  drawMarks(m);
  if (!v) return;
  const dur = () => m.duration || v.duration || 1;
  const tl = $('#tl');
  tl.onclick = ev => {
    const mk = ev.target.closest('[data-id]');
    if (mk) { if (opts.onMark) opts.onMark(+mk.dataset.id); return; }
    const r = tl.getBoundingClientRect(); S.reel = null; updateReelBar();
    v.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * dur();
  };
  if (S.vtFor !== m.id) S.vt = 0;
  S.vtFor = m.id;
  v.addEventListener('loadedmetadata', () => { if (S.vt > 0 && S.vt < v.duration) v.currentTime = S.vt; }, { once: true });
  v.addEventListener('seeked', () => { if (S.ourSeek) { S.ourSeek = false; return; } S.clipEnd = null; if (S.reel) { S.reel = null; updateReelBar(); } });
  S.tick = setInterval(() => {
    const t = v.currentTime; S.vt = t;
    const vt = $('#vtime'); if (vt) vt.textContent = `${clock(t)} / ${clock(dur())}`;
    const p = $('#tlpos'); if (p) p.style.left = Math.min(100, t / dur() * 100) + '%';
    if (opts.onTick) opts.onTick(t);
    if (S.clipEnd != null && t >= S.clipEnd - 0.05) { if (S.reel) nextReel(); else { v.pause(); S.clipEnd = null; } }
  }, 120);
}

// ------------------------------------------------------------ step 1: video
function videoTab(m) {
  const today = new Date().toISOString().slice(0, 10), isNew = !m;
  let dir = m ? m.attackDir || 'right' : lsGet('ps_dir', 'right'), file = null, previewUrl = null;
  const has = m && haveFile(m);
  const form = `<form id="nf" class="card wsForm" autocomplete="off"><h2>${isNew ? 'New match' : 'The match'}</h2>
    <label class="fld"><span>Your team</span><input name="us" required value="${esc(m ? m.us : lsGet('ps_us', ''))}" placeholder="e.g. Norton and Stockton"></label>
    <label class="fld"><span>Opponent</span><input name="them" required value="${esc(m ? m.them : '')}" placeholder="e.g. Pools Youth"></label>
    <label class="fld"><span>Date</span><input type="date" name="date" value="${esc(m ? m.date : today)}" required></label>
    <div class="fld"><span>Your team attacks (1st half)</span>${seg('dirSeg', [['left', '&#8592; Left'], ['right', 'Right &#8594;']], dir)}<small>As you look at the video. It flips at half-time.</small></div>
    <div class="fld"><span>Final score (optional)</span><div class="fs"><label>${esc(m ? m.us : 'Your team')}<input name="fu" type="number" inputmode="numeric" min="0" max="30" value="${m && m.finalUs != null ? m.finalUs : ''}"></label>
      <label>${esc(m ? m.them : 'Opponent')}<input name="ft" type="number" inputmode="numeric" min="0" max="30" value="${m && m.finalThem != null ? m.finalThem : ''}"></label></div>
      <small>If you know it, Gemini and the other clues use it to check they have found every goal.</small></div>
    <details class="fld clockbox" ${m && m.ko1 != null ? 'open' : ''}><summary>Match clock (optional)</summary>
      <small>Lets the stats graphic show when each goal happened, like 12&prime;. Play the video to the kick-off, then press the button beside it.</small>
      <div class="kos"><label>First half kicks off at<input name="ko1" value="${m && m.ko1 != null ? clock(m.ko1) : ''}" placeholder="0:30" inputmode="numeric"></label><button type="button" class="ghost sm" data-ko="ko1">Use video time</button></div>
      <div class="kos"><label>Second half kicks off at<input name="ko2" value="${m && m.ko2 != null ? clock(m.ko2) : ''}" placeholder="32:10" inputmode="numeric"></label><button type="button" class="ghost sm" data-ko="ko2">Use video time</button></div>
      <div class="kos"><label>Length of each half (minutes)<input name="half" type="number" min="10" max="60" inputmode="numeric" value="${m && m.halfLen ? m.halfLen : 45}"></label></div></details>
    <div class="fld"><span>Match video</span>
      <label class="filebtn"><input type="file" id="vf" accept="video/*" hidden><span id="vfName">${has ? esc(S.file.name) : (m && m.video ? 'Choose the video again: ' + esc(m.video.name) : 'Choose video&hellip;')}</span></label>
      <small>It stays on this computer unless you choose Ask Gemini in the next step, which uploads it to Google and deletes it afterwards.</small></div>
    <button class="primary" type="submit" id="nfGo">${isNew ? 'Continue' : 'Save and find highlights'}</button></form>`;
  const prev = `<div class="card vprev" id="vprev">${has ? `<video controls playsinline preload="metadata" src="${S.fileUrl}"></video>` : '<div class="attach"><p id="vprevTxt">Choose the match video to see it here.</p></div>'}</div>`;
  shell(m, 'video', form, prev);
  wireSeg('dirSeg', v => { dir = v; });
  const showPreview = f => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    $('#vprev').innerHTML = `<video controls playsinline preload="metadata" src="${previewUrl}"></video>`;
  };
  $$('[data-ko]').forEach(b => b.onclick = () => {
    const v = $('#vprev video'); if (!v) return toast('Choose the video first');
    $(`input[name=${b.dataset.ko}]`).value = clock(v.currentTime);
  });
  $('#vf').onchange = e => {
    file = e.target.files[0] || null;
    if (!file) return;
    $('#vfName').textContent = file.name; showPreview(file);
    if (m && m.video && m.video.size && file.size !== m.video.size && !confirm('This looks like a different file from the one you used before. Use it anyway?')) { file = null; return go(location.hash); }
  };
  $('#nf').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target), btn = $('#nfGo');
    const fu = parseInt(f.get('fu'), 10), ft = parseInt(f.get('ft'), 10), haveFinal = fu >= 0 && ft >= 0;
    const k1 = parseClockTime(String(f.get('ko1') || '').trim()), k2 = parseClockTime(String(f.get('ko2') || '').trim()), hl = parseInt(f.get('half'), 10);
    const clk = o => { o.ko1 = k1 != null ? k1 : null; o.ko2 = k1 != null && k2 != null && k2 > k1 ? k2 : null; o.halfLen = hl >= 10 && hl <= 60 ? hl : 45; };
    if (isNew) {
      if (!file) return toast('Choose the match video first');
      btn.disabled = true; btn.textContent = 'Reading video…';
      let info;
      try { info = await probeVideo(file); } catch (_) { btn.disabled = false; btn.textContent = 'Continue'; return toast("This browser can't read that video. Try an .mp4 file."); }
      const nm = { id: DB.newId(), us: f.get('us').trim(), them: f.get('them').trim(), date: f.get('date'), attackDir: dir, halfTime: 0, createdAt: Date.now(),
        video: { name: file.name, size: file.size, duration: info.duration }, events: [], duration: info.duration, half: info.duration / 2, curves: null, raw: null,
        finalUs: haveFinal ? fu : null, finalThem: haveFinal ? ft : null };
      clk(nm); lsSet('ps_us', nm.us); lsSet('ps_dir', dir);
      await DB.saveMatch(nm); setFile(nm, file);
      return go(`#/match/${nm.id}/find`);
    }
    m.us = f.get('us').trim(); m.them = f.get('them').trim(); m.date = f.get('date'); m.attackDir = dir;
    m.finalUs = haveFinal ? fu : null; m.finalThem = haveFinal ? ft : null; clk(m);
    if (file) {
      btn.disabled = true; btn.textContent = 'Reading video…';
      try { const info = await probeVideo(file); m.video = { name: file.name, size: file.size, duration: info.duration }; m.duration = info.duration; setFile(m, file); }
      catch (_) { btn.disabled = false; btn.textContent = 'Save and find highlights'; return toast("This browser can't read that video. Try an .mp4 file."); }
    }
    await DB.saveMatch(m); go(`#/match/${m.id}/find`);
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
  app.classList.remove('wide');
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
    if (!m.events) m.events = []; m.curves = out.curves; m.half = out.half;
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
    toast(res.partial ? `Scan stopped early at ${clock(res.coveredTo)}` : 'Scan finished. Now press Search for highlights.');
    go(`#/match/${m.id}/find`);
  } catch (err) {
    S.scanning = null;
    if (err && err.name === 'AbortError') toast('Scan cancelled'); else toast(err.message || 'The scan failed');
    go(`#/match/${m.id}/find`);
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
  for (const e of hlList(m)) {
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

function reelList(m) {
  const tagged = m.events.filter(e => e.type && e.type !== 'skip');
  const base = tagged.length ? tagged.filter(e => e.type !== 'foul' && e.type !== 'kickin') : m.events.filter(e => e.type !== 'skip');
  return [...base].sort((a, b) => a.time - b.time);
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
function addMomentsFrom(m, list) {
  const dur = m.duration || 1e9;
  for (const x of list) {
    if (!TYPES[x.type] || (!x.side && x.type !== 'highlight')) continue;
    if (m.events.some(e => e.type !== 'skip' && Math.abs(e.time - x.t) < 6 && (e.type === x.type || e.type === 'goal'))) continue;
    m.events.push({ id: 0, time: x.t, start: Math.max(0, x.t - 5), end: Math.min(dur, x.t + 8), score: null, label: TYPES[x.type].label, type: x.type, side: x.side || null, manual: false, fromGemini: true });
  }
}
function finishEventEdit(m, selE) {
  const keep = selE === undefined ? m.events.find(e => e.id === S.sel) : selE;
  m.events.sort((a, b) => a.time - b.time); m.events.forEach((e, i) => e.id = i + 1);
  S.sel = keep ? keep.id : null;
  DB.saveMatch(m); drawMarks(m); updateCount(m); if (S.onChange) S.onChange();
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
  let list = m.events.filter(e => e.type && e.type !== 'skip' && e.type !== 'foul' && e.type !== 'kickin' && TYPES[e.type]).sort((a, b) => a.time - b.time);
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

// ------------------------------------------------------------ step 3: review highlights
const FILTERS = [['all', 'All'], ['goal', 'Goals'], ['shots', 'Shots'], ['save', 'Saves'], ['corner', 'Corners'], ['kickin', 'Kick-ins'], ['foul', 'Fouls'], ['cards', 'Cards'], ['highlight', 'Highlights']];
const inFilter = (e, f) => f === 'all' || (f === 'shots' ? (e.type === 'sot' || e.type === 'off') : f === 'cards' ? (e.type === 'yellow' || e.type === 'red') : f === 'skipped' ? e.type === 'skip' : e.type === f);
function statRows(m) {
  const st = stats(m);
  const rows = [['Goals', st.us.goals, st.them.goals], ['Shots', st.us.shots, st.them.shots], ['Shots on target', st.us.sot, st.them.sot],
    ['Saves', st.us.saves, st.them.saves], ['Corners', st.us.corners, st.them.corners], ['Fouls', st.us.fouls, st.them.fouls]];
  if (st.us.kickins + st.them.kickins) rows.push(['Kick-ins', st.us.kickins, st.them.kickins]);
  if (st.us.yellow + st.them.yellow) rows.push(['Yellow cards', st.us.yellow, st.them.yellow]);   // cards are rare, so only shown when there are some
  if (st.us.red + st.them.red) rows.push(['Red cards', st.us.red, st.them.red]);
  return rows;
}
// match minute from the optional kick-off times (video seconds) on the Video step
function minuteLabel(m, t) {
  if (m.ko1 == null) return null;
  const h = m.halfLen || 45;
  if (m.ko2 != null && t >= m.ko2) { const n = h + Math.floor((t - m.ko2) / 60) + 1; return n > 2 * h ? `${2 * h}+${n - 2 * h}\u2032` : `${n}\u2032`; }
  const n = Math.max(1, Math.floor((t - m.ko1) / 60) + 1);
  return m.ko2 != null && n > h ? `${h}+${n - h}\u2032` : `${n}\u2032`;
}
function scorersOf(m) {
  if (m.ko1 == null) return null;
  const by = side => (m.events || []).filter(e => e.type === 'goal' && e.side === side).sort((x, y) => x.time - y.time).map(e => minuteLabel(m, e.time));
  const us = by('us'), them = by('them');
  return us.length || them.length ? { us, them } : null;
}
const statsData = m => ({ us: m.us, them: m.them, rows: statRows(m), scorers: scorersOf(m), title: 'MATCH STATS', sub: `${m.us} v ${m.them} · ${fmtDate(m.date)}` });
function drawStatsCanvas(m) { const cv = $('#statsCv'); if (cv) drawStats(cv.getContext('2d'), cv.width, cv.height, statsData(m), 1); }
function saveStatsPicture(m) {
  const cv = document.createElement('canvas'); cv.width = 1600; cv.height = 800;
  drawStats(cv.getContext('2d'), cv.width, cv.height, statsData(m), 1);
  cv.toBlob(b => {
    if (!b) return toast('Could not make the picture');
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${slug(m.us)}-v-${slug(m.them)}-stats.png`; a.style.display = 'none';
    document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 4000);
    toast('Saved the stats picture to your Downloads');
  }, 'image/png');
}
function hlRow(m, e) {
  const sel = S.sel === e.id, T = TYPES[e.type], skipped = e.type === 'skip';
  const who = e.side ? esc(e.side === 'us' ? m.us : m.them) : '';
  const head = `<button class="hlHead" data-act="sel" aria-expanded="${sel}"><span class="dot ${e.side || 'none'}"></span><b>${clock(e.time)}</b>
    <span class="hlType">${skipped ? 'Skipped' : T ? T.label : 'Pick what happened'}</span><span class="hlWho">${who || (skipped || e.type === 'highlight' ? '' : 'Who?')}</span></button>`;
  const body = !sel ? '' : skipped ? `<div class="hlBody"><div class="hlBtns"><button class="ghost sm" data-act="skip">Restore this highlight</button></div></div>` : `<div class="hlBody">
      <div class="hlRow"><label>What happened<select data-act="type"><option value="">Pick…</option>${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${e.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
        <div class="who"><span>Who</span><div class="seg sm" data-act="side"><button data-side="us" class="${e.side === 'us' ? 'on' : ''}">${esc(m.us)}</button><button data-side="them" class="${e.side === 'them' ? 'on' : ''}">${esc(m.them)}</button></div></div></div>
      <div class="hlRow"><label>Clip starts<input data-act="start" value="${clock(e.start)}" inputmode="numeric"></label><label>Clip ends<input data-act="end" value="${clock(e.end)}" inputmode="numeric"></label></div>
      <div class="hlBtns"><button class="primary sm" data-act="play">&#9654; Play clip</button><button class="ghost sm" data-act="skip">Skip this highlight</button></div></div>`;
  return `<article class="hl${sel ? ' open' : ''}${S.clipId === e.id ? ' playing' : ''}" data-id="${e.id}">${head}${body}</article>`;
}
function renderReview(m) {
  const list = $('#rvList'); if (!list) return;
  const all = (m.events || []).filter(e => isHl(e) || e.type === 'skip').sort((a, b) => a.time - b.time);
  const skipped = all.filter(e => e.type === 'skip').length;
  const filters = skipped ? [...FILTERS, ['skipped', 'Skipped']] : FILTERS;
  if (!filters.some(f => f[0] === S.filter)) S.filter = 'all';
  const count = f => all.filter(e => (f === 'skipped' ? e.type === 'skip' : e.type !== 'skip') && inFilter(e, f)).length;
  $('#rvChips').innerHTML = filters.map(([k, l]) => `<button class="fchip${S.filter === k ? ' on' : ''}" data-f="${k}">${l}<i>${count(k)}</i></button>`).join('');
  const rows = all.filter(e => S.filter === 'skipped' ? e.type === 'skip' : e.type !== 'skip' && inFilter(e, S.filter));
  list.innerHTML = rows.length ? rows.map(e => hlRow(m, e)).join('')
    : `<p class="note empty">${all.length - skipped ? 'Nothing in this group.' : 'No highlights yet. Go to Find highlights, or watch the video and add one with the button below.'}</p>`;
  const st = stats(m), open = (m.events || []).filter(e => e.type === 'goal' && !e.side).length;
  const fin = m.finalUs != null && m.finalThem != null;
  const mismatch = fin && (st.us.goals !== m.finalUs || st.them.goals !== m.finalThem) && !open;
  $('#rvHead').innerHTML = `<div class="rvScore"><span class="us">${esc(m.us)}</span><b class="us">${st.us.goals}</b><i>–</i><b class="them">${st.them.goals}</b><span class="them">${esc(m.them)}</span></div>
    <small>${hlList(m).length} highlight${hlList(m).length === 1 ? '' : 's'} found${fin ? ` · final score you entered ${m.finalUs}–${m.finalThem}` : ''}${open ? ` · ${open} goal${open === 1 ? ' needs' : 's need'} a team picking` : ''}</small>
    ${mismatch ? `<div class="notice sm">The goals here (${st.us.goals}–${st.them.goals}) don&rsquo;t match the final score you entered. A goal may be missing or wrong.</div>` : ''}`;
  const gs = (m.events || []).filter(e => e.fromGemini && (e.type === 'sot' || e.type === 'off')).length;
  $('#rvTools').innerHTML = gs ? `<div class="notice sm">Gemini guessed ${gs} shot${gs === 1 ? '' : 's'}. If many are not really shots, <button class="linkbtn" id="shots2hl">turn them into plain highlights</button> (they stay in the video but stop counting as shots).</div>` : '';
  const sb = $('#shots2hl'); if (sb) sb.onclick = () => { for (const e of m.events) if (e.fromGemini && (e.type === 'sot' || e.type === 'off')) { e.type = 'highlight'; e.label = TYPES.highlight.label; } finishEventEdit(m); toast('Done. Change any real shots back with the dropdown.'); };
  drawMarks(m); drawStatsCanvas(m); updateCount(m);
}
function reviewTab(m) {
  const hasCurves = !!(m.curves && m.curves.us && m.curves.us.length);
  const left = `${playerHtml(m)}
    <section class="statsBox"><div class="statsHd"><h3>Match stats</h3><button class="ghost sm" id="saveStats">Save as picture</button></div>
      <canvas id="statsCv" width="1280" height="640" role="img" aria-label="Team stats comparison"></canvas>
      <label class="chk"><input type="checkbox" id="statsEnd" ${m.statsEnd ? 'checked' : ''}><span>Add this graphic to the end of the highlights video</span></label></section>
    ${hasCurves ? `<details class="card flowbox"><summary>Match flow</summary><div id="chart" class="chart">${flowChart(m)}</div><p class="note">Estimated share of the play, from camera movement and crowd noise. Click a marker to jump to it.</p></details>` : ''}`;
  const right = `<div class="rv"><div class="rvHeadWrap" id="rvHead"></div><div class="chips2" id="rvChips"></div><div id="rvTools"></div><div class="rvList" id="rvList"></div>
    <div class="rvFoot"><div class="rvAdd"><button class="ghost sm full" id="addHl" ${haveFile(m) ? '' : 'disabled'}>+ Add a highlight at the current time</button>
      <button class="ghost sm" id="playReel" ${haveFile(m) ? '' : 'disabled'}>&#9654; Play all</button><button class="ghost sm" id="goalUs" ${haveFile(m) ? '' : 'disabled'}>Goal: ${esc(m.us)}</button><button class="ghost sm" id="goalThem" ${haveFile(m) ? '' : 'disabled'}>Goal: ${esc(m.them)}</button></div>
      <a class="primary" href="#/match/${m.id}/export">Next: export</a></div></div>`;
  shell(m, 'review', left, right);
  const select = (id, play) => {
    S.sel = S.sel === id && !play ? null : id;
    renderReview(m);
    const e = m.events.find(x => x.id === id), row = e && $(`.hl[data-id="${id}"]`);
    if (S.sel === id && e) { const v = $('#vid'); if (v && !play) { S.ourSeek = true; v.currentTime = Math.max(0, e.start); } if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  };
  wirePlayer(m, { onMark: id => select(id, true) });
  S.onChange = () => renderReview(m);
  renderReview(m);
  if (S.pendingPlay != null) { const e = m.events.find(x => x.id === S.pendingPlay); S.pendingPlay = null; if (e) select(e.id, true); }
  const ch = $('#chart'); if (ch) ch.onclick = ev => { const g = ev.target.closest('.mk'); if (g) select(+g.dataset.id, true); };
  $('#statsEnd').onchange = ev => { m.statsEnd = ev.target.checked; DB.saveMatch(m); };
  $('#saveStats').onclick = () => saveStatsPicture(m);
  $('#rvChips').onclick = ev => { const b = ev.target.closest('[data-f]'); if (b) { S.filter = b.dataset.f; renderReview(m); } };
  const quick = side => () => { const v = $('#vid'); if (!v) return needVideo(); const e = addGoalAt(m, v.currentTime, side); finishEventEdit(m, e); toast(`Goal marked at ${clock(v.currentTime)} for ${side === 'us' ? m.us : m.them}`); };
  $('#goalUs').onclick = quick('us'); $('#goalThem').onclick = quick('them');
  $('#playReel').onclick = () => {
    if (!haveFile(m)) return needVideo();
    const rl = reelList(m); if (!rl.length) return toast('Nothing to play yet');
    S.reel = { list: rl, i: 0 }; playClip(rl[0]); updateReelBar();
  };
  $('#addHl').onclick = () => {
    const v = $('#vid'); if (!v) return needVideo();
    const t = v.currentTime, pre = m.preGoal ?? 10, post = m.postGoal ?? 10, dur = m.duration || t + post;
    const e = { id: 0, time: t, start: Math.max(0, t - pre), end: Math.min(dur, t + post), score: null, label: 'Added by you', type: null, side: null, manual: true };
    m.events.push(e); S.filter = 'all'; finishEventEdit(m, e); toast(`Added a highlight at ${clock(t)}. Say what happened.`);
  };
  const list = $('#rvList');
  list.onclick = ev => {
    const row = ev.target.closest('.hl'); if (!row) return;
    const e = m.events.find(x => x.id === +row.dataset.id); if (!e) return;
    const sideBtn = ev.target.closest('[data-side]'), actEl = ev.target.closest('[data-act]');
    if (sideBtn) { e.side = sideBtn.dataset.side; if (e.guess) { e.label = 'Goal'; e.guess = false; } return finishEventEdit(m, e); }
    if (!actEl) return;
    const act = actEl.dataset.act;
    if (act === 'sel') select(e.id);
    else if (act === 'play') { S.reel = null; updateReelBar(); playClip(e); }
    else if (act === 'skip') {
      if (e.type === 'skip') { e.type = e.prevType || null; e.prevType = null; } else { e.prevType = e.type; e.type = 'skip'; S.sel = null; }
      finishEventEdit(m, e.type === 'skip' ? null : e);
    }
  };
  list.onchange = ev => {
    const t = ev.target, row = t.closest('.hl'); if (!row) return;
    const e = m.events.find(x => x.id === +row.dataset.id); if (!e) return;
    if (t.matches('select[data-act="type"]')) {
      e.type = t.value || null; if (e.type) { e.label = TYPES[e.type].label; if (!e.side && e.type !== 'highlight') e.side = 'us'; } else e.side = null;
      e.guess = false; return finishEventEdit(m, e);
    }
    if (t.matches('input[data-act="start"], input[data-act="end"]')) {
      const v = parseClockTime(t.value.trim()), key = t.dataset.act;
      if (v == null || v < 0 || (m.duration && v > m.duration)) { toast('Type a time like 12:34'); t.value = clock(e[key]); return; }
      const ns = key === 'start' ? v : e.start, ne = key === 'end' ? v : e.end;
      if (ne - ns < 2) { toast('The clip must be at least 2 seconds long'); t.value = clock(e[key]); return; }
      e.start = ns; e.end = ne; DB.saveMatch(m);
    }
  };
}

// player helpers shared by the tabs
function needVideo() { toast('Attach the match video first'); const a = $('#playerWrap'); if (a) a.scrollIntoView({ behavior: 'smooth' }); }
function playClip(e) {
  const v = $('#vid'); if (!v) return needVideo();
  S.clipEnd = e.end; S.clipId = e.id;
  const goTo = () => { S.ourSeek = true; v.currentTime = e.start; v.play().catch(() => {}); };
  if (v.readyState >= 1) goTo(); else v.addEventListener('loadedmetadata', goTo, { once: true });
  $$('.hl').forEach(c => c.classList.toggle('playing', +c.dataset.id === e.id));
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

// ------------------------------------------------------------ step 4: export
const sbHtml = (m, sc) => `<span>${esc(abbrOf(m.us))}</span><b>${sc.us}</b><b>${sc.them}</b><span>${esc(abbrOf(m.them))}</span>`;
const abbrOf = s => String(s || '').replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/)[0].slice(0, 3).toUpperCase() || '---';
function exportTab(m) {
  const sbOn = m.sbOn !== false, pos = m.sbPos || 'tl', mode = m.vidMode || 'all', has = haveFile(m);
  const left = playerHtml(m, { sb: true });
  const right = `<div class="ex"><h2>Export</h2><p class="note" id="vidInfo"></p>
    <div id="vidResultWrap">${videoResultCard(m)}</div>
    <div class="card exCard">
      <div class="fld"><span>What to include</span>${seg('vidMode', [['goals', 'Goals only'], ['all', 'All highlights']], mode)}</div>
      <div class="fld"><span>Scoreboard graphic</span>${seg('sbMode', [['on', 'Add a scoreboard'], ['off', 'No scoreboard']], sbOn ? 'on' : 'off')}
        <div id="sbPosWrap" ${sbOn ? '' : 'hidden'}>${seg('sbPos', [['tl', 'Top left'], ['tr', 'Top right']], pos)}</div>
        <small>Choose &ldquo;No scoreboard&rdquo; if the video already shows one.</small></div>
      <div class="fld"><span>Seconds around each goal</span><div class="fs"><label>Before<input id="preGoal" type="number" min="3" max="60" inputmode="numeric" value="${m.preGoal ?? 10}"></label>
        <label>After<input id="postGoal" type="number" min="3" max="60" inputmode="numeric" value="${m.postGoal ?? 10}"></label></div></div>
      <label class="chk"><input type="checkbox" id="statsEnd" ${m.statsEnd ? 'checked' : ''}><span>Show the match stats graphic at the end (about 8 seconds)</span></label>
      <label class="chk"><input type="checkbox" id="csvToo" ${m.csvToo ? 'checked' : ''}><span>Also save the match data as a spreadsheet (.csv)</span></label>
      <button class="primary wide" id="makeVideo" ${has ? '' : 'disabled'}>Make the video</button>
      <p class="note">Adds a GOAL banner, then saves a video file you can share. It plays the clips in real time, so a 3 minute video takes about 3 minutes. Keep this tab in front while it works.</p></div></div>`;
  shell(m, 'export', left, right);
  const upSb = () => {
    const el = $('#sbov'); if (!el) return;
    const on = m.sbOn !== false; el.hidden = !on; el.className = 'sbov ' + (m.sbPos || 'tl');
    const v = $('#vid'); el.innerHTML = sbHtml(m, scoreAt(m, v ? v.currentTime : 0, true));
  };
  wirePlayer(m, { onTick: upSb, onMark: id => { const e = m.events.find(x => x.id === id); if (e) { S.reel = null; updateReelBar(); playClip(e); } } });
  S.onChange = () => { updateVidInfo(m); upSb(); };
  upSb(); updateVidInfo(m);
  const num = (el, d) => Math.max(3, Math.min(60, parseInt(el.value, 10) || d));
  $('#preGoal').onchange = ev => { m.preGoal = num(ev.target, 10); DB.saveMatch(m); updateVidInfo(m); };
  $('#postGoal').onchange = ev => { m.postGoal = num(ev.target, 10); DB.saveMatch(m); updateVidInfo(m); };
  wireSeg('vidMode', v => { m.vidMode = v; DB.saveMatch(m); updateVidInfo(m); });
  wireSeg('sbMode', v => { m.sbOn = v === 'on'; DB.saveMatch(m); $('#sbPosWrap').hidden = !m.sbOn; upSb(); });
  wireSeg('sbPos', v => { m.sbPos = v; DB.saveMatch(m); upSb(); });
  $('#statsEnd').onchange = ev => { m.statsEnd = ev.target.checked; DB.saveMatch(m); updateVidInfo(m); };
  $('#csvToo').onchange = ev => { m.csvToo = ev.target.checked; DB.saveMatch(m); };
  $('#makeVideo').onclick = () => runExport(m);
  wireVideoResult(m);
}
function updateVidInfo(m) {
  const el = $('#vidInfo'); if (!el) return;
  const clips = clipsFor(m, m.vidMode || 'all'), secs = clips.reduce((s, c) => s + c.end - c.start, 0) + 6 + (m.statsEnd ? 8 : 0);
  const g = goalsOf(m), open = m.events.filter(e => e.type === 'goal' && !e.side).length;
  let t = clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'}, about ${clock(secs)} long. Score so far ${m.us} ${g.filter(e => e.side === 'us').length}–${g.filter(e => e.side === 'them').length} ${m.them}.`
                       : 'Nothing to put in a video yet. Find or add some highlights first.';
  if (open) t += ` ${open} goal${open === 1 ? ' needs' : 's need'} a team picking first (Review step).`;
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
    ${v.canShare ? '<button class="ghost wide" id="shareVideo">Share&hellip;</button>' : ''}</section>`;
}
function wireVideoResult(m) {
  const sh = $('#shareVideo'); if (sh) sh.onclick = () => navigator.share({ files: [new File([S.video.blob], S.video.name, { type: S.video.blob.type })], title: `${m.us} v ${m.them}` }).catch(() => {});
}
async function runExport(m) {
  if (!haveFile(m)) return needVideo();
  if (!pickMime()) return toast("This browser can't record video. Use Chrome or Edge on a computer.");
  if (m.events.some(e => e.type === 'goal' && !e.side)) return toast('Pick who scored on each goal first (Review step)');
  const clips = clipsFor(m, m.vidMode || 'all'); if (!clips.length) return toast('Nothing to export yet');
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
      scoreboard: m.sbOn !== false, sbPos: m.sbPos || 'tl', stats: m.statsEnd ? statsData(m) : null,
      onProgress: p => { const b = $('#xbar'); if (b) { b.style.width = Math.round(p.frac * 100) + '%'; $('#xtxt').textContent = `${Math.round(p.frac * 100)}% · ${clock(p.done)} of ${clock(p.total)}. Keep this tab in front.`; } },
    });
    if (S.video && S.video.url) URL.revokeObjectURL(S.video.url);
    const name = `${slug(m.us)}-v-${slug(m.them)}-highlights.${res.ext}`;
    const canShare = !!(navigator.canShare && navigator.maxTouchPoints > 1 && navigator.canShare({ files: [new File([res.blob], name, { type: res.mime })] }));
    S.video = { matchId: m.id, blob: res.blob, url: URL.createObjectURL(res.blob), name, ext: res.ext, seconds: res.seconds, clips: clips.length, canShare, when: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) };
    scrim.remove();
    const wrap = $('#vidResultWrap');
    if (wrap) { wrap.innerHTML = videoResultCard(m); wireVideoResult(m); wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    if (m.csvToo) downloadMatchData(m);
    toast(res.hasAudio ? 'Your video is ready. Click Download highlights.' : 'Your video is ready (no sound).');
  } catch (err) {
    scrim.remove();
    if (!(err && err.name === 'AbortError')) toast(err.message || 'Could not make the video');
  }
}

// ------------------------------------------------------------ smart goal finder helpers
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
const G = { key: lsGet('ps_gemini_key', ''), pass: lsGet('ps_gemini_pass', ''), rem: !!(lsGet('ps_gemini_key', '') || lsGet('ps_gemini_pass', '')), ok: false, extra: false, models: null, model: '' };
// On a host with the Cloudflare Worker (worker/gemini-proxy.js) set <meta name="pitchside-gemini-proxy" content="/api/gemini"> in index.html:
// the key then stays on the server and people only enter an access code (or nothing).
const GPROXY = ((document.querySelector('meta[name="pitchside-gemini-proxy"]') || {}).content || '').trim();
const gAuth = () => (GPROXY ? { proxy: GPROXY, pass: G.pass } : G.key);

// ------------------------------------------------------------ step 2: find highlights
S.open = { gemini: true };
function findTab(m) {
  let ctrl = null, picks = new Set(), cands = [], busy = false, msg = '';
  const typed = [m.finalUs != null ? String(m.finalUs) : '', m.finalThem != null ? String(m.finalThem) : ''];
  const top = `<div class="fpTop"><div class="fs"><label>${esc(m.us)}<input id="sfUs" type="number" inputmode="numeric" min="0" max="30" value="${typed[0]}"></label>
      <span class="dash">&ndash;</span><label>${esc(m.them)}<input id="sfThem" type="number" inputmode="numeric" min="0" max="30" value="${typed[1]}"></label></div>
      <small>Final score (optional). It makes the result much better.</small></div>`;
  shell(m, 'find', playerHtml(m), `<div class="fp">${top}<div class="fpScroll" id="fpScroll"></div><div class="fpBot" id="fpBot"></div></div>`);
  wirePlayer(m, { onMark: id => { S.sel = id; go(`#/match/${m.id}/review`); } });
  const saveFinal = () => {
    typed[0] = $('#sfUs').value; typed[1] = $('#sfThem').value;
    const a = parseInt(typed[0], 10), b = parseInt(typed[1], 10);
    m.finalUs = a >= 0 ? a : null; m.finalThem = b >= 0 ? b : null; DB.saveMatch(m);
  };
  $('#sfUs').oninput = $('#sfThem').oninput = saveFinal;
  const sec = (k, title, tag, state, body) => `<details class="sec" data-k="${k}" ${S.open[k] ? 'open' : ''}><summary><span class="sn">${title}</span>${tag ? `<i class="tag2">${tag}</i>` : ''}<small class="st">${state || ''}</small></summary><div class="sb">${body}</div></details>`;
  const keyVal = GPROXY ? G.pass : G.key;
  const bodyHtml = () => {
    const gem = m.gemini;
    return (cands.length || hasMoms() ? `<div class="res"><h4>${cands.length ? 'Goals found' : 'Highlights found'}</h4><div id="sfList"></div></div>` : '') +
    sec('gemini', 'Ask Gemini', 'Recommended', gem ? `${gem.goals.length} goal${gem.goals.length === 1 ? '' : 's'}` : '', `
      <p class="note">${gem ? `Done: Gemini found ${gem.goals.length} goal${gem.goals.length === 1 ? '' : 's'} (${esc(gem.model)}).` : `Gemini is Google&rsquo;s AI. It watches the whole match, lists the goals, then takes a closer look at each one. ${GPROXY ? '' : 'Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>.'}`}</p>
      ${gem && gem.warnings && gem.warnings.length ? `<ul class="gemw">${gem.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${(() => { const r = restingModels().filter(x => G.models ? G.models.some(y => y.name === x.name) : true); return r.length ? `<p class="note">Skipped for now: ${r.map(x => `${esc(x.name)} (${KIND_TEXT[x.kind]})`).join(', ')}.</p>` : ''; })()}
      <div class="gem"><input id="gKey" type="password" autocomplete="off" spellcheck="false" placeholder="${GPROXY ? 'Access code (if you were given one)' : 'Paste your Gemini key'}" value="${esc(keyVal)}">
      ${G.models ? `<label class="fld"><span>Start with this model (it switches to the next one if it is busy or out of free requests)</span><select id="gModel">${G.models.map(x => `<option value="${esc(x.name)}" ${x.name === G.model ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
      <label class="chk"><input type="checkbox" id="gOk" ${G.ok ? 'checked' : ''}><span>I&rsquo;m happy for this video to be uploaded to Google with my key. (Google may use free-tier uploads to improve its products, so avoid footage you should not share, such as other people&rsquo;s children.)</span></label>
      <label class="chk"><input type="checkbox" id="gExtra" ${G.extra ? 'checked' : ''}><span>Also look for shots, saves, corners, kick-ins and fouls (slower, and they are guesses to check)</span></label>
      <label class="chk"><input type="checkbox" id="gRem" ${G.rem ? 'checked' : ''}><span>Remember ${GPROXY ? 'the access code' : 'the key'} on this device</span></label>
      <div class="gbtns"><button class="ghost" id="sfGem" ${busy ? 'disabled' : ''}>${gem ? 'Ask again' : 'Ask Gemini'}</button><button class="ghost" id="gForget" ${keyVal && !busy ? '' : 'hidden'}>Forget ${GPROXY ? 'code' : 'key'}</button></div></div>`) +
    sec('ball', 'Track the ball', 'Beta', m.ballTrack ? 'Done' : '', `
      <p class="note">Follows the ball in the video to find goals: the ball reaching a goal, then a kick-off from the centre spot. Slow, but needs no tagging. Needs a ball model file (<code>.onnx</code>), loaded once.</p>
      <p class="note">${ballStateText()}</p>
      <label class="btn ghost filebtn"><input id="ballModel" type="file" accept=".onnx" hidden>${S.ball.name ? 'Use a different model file' : 'Choose the ball model (.onnx)'}</label>
      <div class="fld"><span>Detail</span>${seg('ballSeg', [[1, 'Quick &middot; 1/s'], [2, 'Balanced &middot; 2/s'], [3, 'Thorough &middot; 3/s']], S.ballFps)}<small id="ballEta"></small></div>
      <button class="ghost wide" id="goBall" ${busy || !haveFile(m) || !S.ball.name ? 'disabled' : ''}>Track the ball and find goals</button>`) +
    sec('board', 'Scoreboard reader', '', m.scoreBoxes ? (m.scoreEvents ? `${m.scoreEvents.length} changes` : 'Area set') : '', `
      <p class="note">If the video shows a scoreboard, mark where the two score numbers are. The crowd noise scan below then notices every time one changes, which gives goal times and who scored.</p>
      ${m.scoreBoxes ? `<p class="note">${m.scoreEvents ? `Last scan saw ${m.scoreEvents.length} score change${m.scoreEvents.length === 1 ? '' : 's'}${m.scoreNoisy ? ' (the area kept changing, so it may include the clock. Mark just the numbers and scan again)' : ''}.` : 'Score area set. It is read during the next crowd noise scan.'}</p>` : ''}
      <button class="ghost wide" id="markScore" ${haveFile(m) ? '' : 'disabled'}>${m.scoreBoxes ? 'Change the score area' : 'Mark the score area'}</button>
      ${m.scoreEvents && m.scoreEvents.length ? `<button class="ghost wide" id="useScore">Use these ${m.scoreEvents.length} changes as the goals</button>` : ''}`) +
    sec('sound', 'Cheering and whistles', '', m.sound ? 'Done' : '', `
      <p class="note">Listens to the crowd for cheering, applause and whistles. Runs in this browser (Chrome or Edge) and is quick.</p>
      <button class="ghost wide" id="sfSound" ${busy ? 'disabled' : ''}>${m.sound ? 'Listen again' : 'Listen for cheering and whistles'}</button>`) +
    sec('speech', 'Spoken &ldquo;goal&rdquo;', '', m.speech ? `${m.speech.hits.length} mentions` : '', `
      <p class="note">Listens for anyone saying &ldquo;goal&rdquo; on the recording. Only helps if there are voices on it. The first time, it downloads a speech model.</p>
      <button class="ghost wide" id="sfSpeech" ${busy ? 'disabled' : ''}>${m.speech ? 'Listen again' : 'Listen for &ldquo;goal&rdquo;'}</button>`) +
    sec('crowd', 'Crowd noise scan', '', m.raw ? 'Scanned' : '', `
      <p class="note">Plays the video silently at speed and measures the noise and the action. It also reads the scoreboard if you marked it. About 15 minutes per hour of footage. Keep this screen open.</p>
      <div class="fld"><span>Scan speed</span>${seg('rateSeg', [[4, 'Thorough &middot; &times;4'], [8, 'Quick &middot; &times;8']], S.rate)}<small id="eta"></small></div>
      <button class="ghost wide" id="goScan" ${haveFile(m) && !busy ? '' : 'disabled'}>${m.raw ? 'Scan again' : 'Scan the match'}</button>
      <label class="btn ghost filebtn"><input id="ifile" type="file" accept=".json,application/json" hidden>Import an analysis from the desktop script</label>`) +
    sec('typed', 'Type the goal times', '', '', `
      <p class="note">If you already know the times, type them from the video player, one per line, with who scored. For example:</p>
      <pre class="eg">12:34 ${esc(m.us)}\n34:33 ${esc(m.them)}\n1:02:10 us</pre>
      <textarea id="goalTimes" rows="4" placeholder="12:34 ${esc(m.us)}"></textarea>
      <button class="ghost wide" id="addGoals">Add these goals</button>`);
  };
  const hasMoms = () => !!(m.gemini && m.gemini.moments && m.gemini.moments.length);
  const render = (text) => {
    if (text != null) msg = text;
    const sc = $('#fpScroll'), st = sc.scrollTop;
    const gt = $('#goalTimes'), goalTxt = gt ? gt.value : '';
    sc.innerHTML = bodyHtml();
    sc.scrollTop = st; if ($('#goalTimes')) $('#goalTimes').value = goalTxt;
    $('#fpBot').innerHTML = `<p class="note" id="sfMsg">${esc(msg)}</p>
      <div class="fpBtns">${busy ? '<button class="ghost" id="sfStop">Stop</button>' : `<button class="ghost" id="sfGo">${cands.length ? 'Search again' : 'Search for highlights'}</button>`}
      <button class="primary" id="sfAdd" ${cands.length || hasMoms() ? '' : 'hidden'}></button></div>`;
    $$('details.sec', sc).forEach(d => d.ontoggle = () => { S.open[d.dataset.k] = d.open; });
    wireSec(); if (cands.length || hasMoms()) drawCands();
  };
  S.refresh = () => render();
  const setMsg = t => { msg = t; const e = $('#sfMsg'); if (e) e.textContent = t; };
  const eta = () => { const e = $('#eta'), d = m.video && m.video.duration; if (e) e.textContent = d ? `About ${Math.max(1, Math.ceil(d / S.rate / 60))} min` : ''; };
  const wireSec = () => {
    const on = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; };
    on('sfStop', () => ctrl && ctrl.abort()); on('sfGo', () => combine()); on('sfSound', () => runSound()); on('sfSpeech', () => runSpeech()); on('sfGem', () => runGemini());
    on('gForget', () => { G.key = ''; G.pass = ''; G.models = null; G.rem = false; lsSet('ps_gemini_key', ''); lsSet('ps_gemini_pass', ''); render('Forgotten.'); });
    on('markScore', () => markScoreArea(m, () => render())); on('goScan', () => startScan(m)); on('goBall', () => runBallScan(m)); on('addGoals', () => { addGoalsFromText(m); render(); });
    on('useScore', () => {
      m.events = m.events.filter(e => !(e.guess && !e.side));
      for (const e of m.scoreEvents) { const g = addGoalAt(m, e.time, e.side); g.fromScoreboard = true; g.label = 'Goal (scoreboard)'; }
      m.finalUs = m.scoreEvents.filter(e => e.side === 'us').length; m.finalThem = m.scoreEvents.length - m.finalUs;
      finishEventEdit(m); toast(`Marked ${m.scoreEvents.length} goals from the scoreboard`); go(`#/match/${m.id}/review`);
    });
    const k = $('#gKey'); if (k) k.oninput = () => { if (GPROXY) G.pass = k.value.trim(); else G.key = k.value.trim(); };
    const gm = $('#gModel'); if (gm) gm.onchange = () => { G.model = gm.value; };
    [['gOk', 'ok'], ['gExtra', 'extra'], ['gRem', 'rem']].forEach(([id, key]) => { const e = $('#' + id); if (e) e.onchange = () => { G[key] = e.checked; }; });
    wireSeg('rateSeg', v => { S.rate = +v; eta(); }); eta();
    wireSeg('ballSeg', v => { S.ballFps = +v; ballEta(m); }); ballEta(m);
    const bm = $('#ballModel'); if (bm) bm.onchange = e => chooseBallModel(m, e.target.files[0]);
    const imp = $('#ifile'); if (imp) imp.onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { await importAnalysis(m, f); await DB.saveMatch(m); toast('Analysis imported'); render('Analysis imported.'); } catch (err) { toast(err.message || 'Could not read that file'); }
    };
  };
  const needAudio = () => { if (!haveFile(m)) { toast('Attach the match video first'); return false; } if (!audioSupported()) { setMsg('This needs Chrome or Edge on a computer.'); return false; } return true; };
  async function runSound(fileForModel) {
    if (!needAudio()) return; busy = true; render('Starting…'); ctrl = new AbortController();
    try {
      if (!S.yam) {
        const buf = fileForModel || await getYamnetBuffer(t => setMsg(t));
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
    if (!haveFile(m)) return toast('Attach the match video first');
    if (!GPROXY && !G.key) return setMsg('Paste your Gemini key first.');
    if (!G.ok) return setMsg('Tick the box to say you are happy for the video to be uploaded to Google.');
    let dur = m.duration || (m.video && m.video.duration) || 0;
    if (!dur) { try { dur = (await probeVideo(S.file)).duration; } catch (_) {} }
    if (!dur || !isFinite(dur)) return setMsg('I could not work out how long the video is.');
    const fa = parseInt($('#sfUs').value, 10), fb = parseInt($('#sfThem').value, 10), haveFinal = fa >= 0 && fb >= 0;
    busy = true; render('Checking access…'); ctrl = new AbortController(); let up = null; const auth = gAuth();
    try {
      if (!G.models) { G.models = await listModels(auth, { signal: ctrl.signal }); }
      const saved = lsGet('ps_gemini_model', '');
      if (!G.models.some(x => x.name === G.model)) G.model = saved && G.models.some(x => x.name === saved) ? saved : G.models[0].name;
      lsSet('ps_gemini_key', G.rem && !GPROXY ? G.key : ''); lsSet('ps_gemini_pass', G.rem && GPROXY ? G.pass : ''); lsSet('ps_gemini_model', G.model);
      setMsg('Uploading the video to Google… 0%');
      up = await uploadVideo(auth, S.file, { signal: ctrl.signal, onProgress: f => setMsg(`Uploading the video to Google… ${Math.round(f * 100)}% (a 200 MB match can take several minutes)`) });
      const sideOf = t => sideFromText(m, t);
      const names = [G.model, ...G.models.map(x => x.name).filter(n => n !== G.model)];
      const onSwitch = (name, kind, next) => setMsg(`${name} is ${KIND_TEXT[kind]}. ${next ? 'Trying ' + next + '…' : 'No other models left to try.'}`);
      const common = { us: m.us, them: m.them, duration: dur, sideOf, signal: ctrl.signal };
      const gr = await withModels(names, name => geminiGoals(auth, name, up, { ...common, finalUs: haveFinal ? fa : null, finalThem: haveFinal ? fb : null, onProgress: t => setMsg(`${name}: ${t}`) }), { signal: ctrl.signal, onSwitch });
      const r = gr.result; G.model = gr.model; lsSet('ps_gemini_model', G.model);
      let moments = [], momNote = '';
      if (G.extra) {
        try {
          const mr = await withModels([G.model, ...names.filter(n => n !== G.model)], name => geminiMoments(auth, name, up, { ...common, onProgress: t => setMsg(`${name}: ${t}`) }), { signal: ctrl.signal, onSwitch });
          moments = mr.result;
        } catch (err) { if (ctrl.signal.aborted) throw err; momNote = ' The shots, saves, corners, kick-ins and fouls could not be checked this time.'; }
      }
      m.gemini = { model: G.model, at: Date.now(), goals: r.goals.map(g => ({ t: g.t, side: g.side, conf: g.conf, note: g.note, fine: !!g.fine, unsure: !!g.unsure, gap: !!g.gap })), warnings: r.warnings, moments: moments.filter(x => x.side || x.type === 'highlight') };
      await DB.saveMatch(m);
      busy = false;
      combine(`${G.model} listed ${r.goals.length} goal${r.goals.length === 1 ? '' : 's'}: ${r.goals.map(g => clock(g.t) + (g.fine ? '' : '?')).join(', ') || 'none'}${moments.length ? `, plus ${moments.length} other highlights` : ''}.${momNote}`);
    } catch (err) {
      busy = false; if (err.status === 400 || err.status === 401 || err.status === 403) G.models = null;
      render(err.message || 'Gemini did not work');
    } finally { if (up) deleteUpload(auth, up.name); }
  }
  function combine(prefix) {
    const a = parseInt($('#sfUs').value, 10), b = parseInt($('#sfThem').value, 10);
    const known = a >= 0 && b >= 0 ? a + b : null;
    if (known === 0) { cands = []; picks = new Set(); m.finalUs = 0; m.finalThem = 0; DB.saveMatch(m); return render(hasMoms() ? `${prefix ? prefix + ' ' : ''}0–0, so there are no goals. The other highlights are below.` : '0–0, so there are no goals. Use Ask Gemini to search for other highlights.'); }
    if (known != null) { m.finalUs = a; m.finalThem = b; DB.saveMatch(m); }
    const { ev, notes } = evidenceFor(m, known);
    if (!ev.length && !hasMoms()) return render('There is no evidence yet. Try Ask Gemini, the crowd noise scan, the ball tracker or one of the Listen buttons first.');
    cands = ev.length ? fuse(ev, { n: known }) : [];
    picks = new Set(); cands.forEach((c, i) => { if (c.picked) picks.add(i); });
    const names = { crowd: 'crowd noise', board: 'scoreboard', ball: 'ball', cheer: 'cheering', speech: 'speech', gemini: 'Gemini' };
    render(`${prefix ? prefix + ' ' : ''}Used: ${Object.keys(notes).map(k => names[k] || k).join(', ')}.${known != null ? ` Kept the ${known} most likely, for a final score of ${a}–${b}.` : ' Without the final score it keeps only the strongest.'}`);
    const r = $('.res'); if (r) r.scrollIntoView({ block: 'nearest' });
  }
  function drawCands() {
    const rows = cands.map((c, i) => [c, i]).sort((x, y) => (y[0].picked - x[0].picked) || (x[0].time - y[0].time));
    $('#sfList').innerHTML = rows.map(([c, i]) => `<label class="cand big"><input type="checkbox" data-i="${i}" ${picks.has(i) ? 'checked' : ''}>
      <b>${clock(c.time)}</b><span class="chips">${c.evidence.map(e => `<i class="chip">${esc(e.label)}</i>`).join('')}</span><em>${Math.round(c.score * 100)}%</em></label>`).join('')
      + (m.gemini && m.gemini.moments && m.gemini.moments.length ? `<label class="chk extra"><input type="checkbox" id="sfMoms" checked><span>Also add the ${m.gemini.moments.length} other highlights Gemini found: shots, saves, corners, cards and plain highlights (guesses, so check them)</span></label>` : '');
    $$('#sfList input[data-i]').forEach(cb => cb.onchange = () => { cb.checked ? picks.add(+cb.dataset.i) : picks.delete(+cb.dataset.i); upd(); });
    const mc = $('#sfMoms'); if (mc) mc.onchange = upd;
    upd();
  }
  function upd() {
    const b = $('#sfAdd'); if (!b || (!cands.length && !hasMoms())) return;
    const mo0 = $('#sfMoms'), mom = !!(mo0 && mo0.checked);
    b.hidden = false; b.disabled = !picks.size && !mom;
    b.textContent = picks.size ? `Add ${picks.size} goal${picks.size === 1 ? '' : 's'}${mom ? ' + highlights' : ''} & review` : mom ? 'Add highlights & review' : 'Tick what to add';
    b.onclick = async () => {
      [...picks].sort((x, y) => cands[x].time - cands[y].time).forEach(i => addGoalAt(m, cands[i].time, cands[i].side));
      const mo = $('#sfMoms'); if (mo && mo.checked && m.gemini && m.gemini.moments) addMomentsFrom(m, m.gemini.moments);
      finishEventEdit(m); toast('Added. Check each one in Review.'); go(`#/match/${m.id}/review`);
    };
  }
  render('');
}

// ------------------------------------------------------------ ball tracker (beta)
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
    toast('Model loaded: ' + f.name); if (S.refresh) S.refresh();
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
    toast('Added. Check who scored on each one.'); go(`#/match/${m.id}/review`);
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

function loadModel() { try { const j = JSON.parse(lsGet('ps_goal_model', 'null')); return j && j.w && j.w.length === 6 ? j : null; } catch (_) { return null; } }

// ============================================================ go
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost','127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
