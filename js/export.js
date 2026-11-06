// Pitchside highlights exporter.
// Plays the chosen clips from the match video into a canvas, draws a broadcast-style score graphic on top,
// and records the result with MediaRecorder. Everything happens in the browser; nothing is uploaded.

const NAVY = '#0B1F3A', YEL = '#F1B51C', WHITE = '#FFFFFF', GREEN = '#14804A', CLAY = '#D9552B';
const abbr = s => String(s || '').replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/)[0].slice(0, 3).toUpperCase() || '---';
const ease = x => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const clock = sec => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };

export function pickMime() {
  const c = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  if (typeof MediaRecorder === 'undefined') return null;
  return c.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || null;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}


// Sky-style team stats panel. d = { us, them, rows: [[label, a, b], ...], title, sub }. prog (0..1) animates the bars.
export function drawStats(ctx, W, H, d, prog = 1) {
  const s = W / 1280, f = n => n * s;
  const GRN = '#3DD68C', CLY = '#FF7A50', INK = '#EEF3EE', MUT = '#98A89F';
  const t = (str, x, y, size, color, weight = 800, align = 'left') => {
    ctx.font = `${weight} ${Math.round(f(size))}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(str, x, y);
  };
  ctx.save();
  ctx.fillStyle = '#0C1511'; ctx.fillRect(0, 0, W, H);
  const hh = Math.round(H * 0.17);
  ctx.fillStyle = '#14201A'; ctx.fillRect(0, 0, W, hh);
  ctx.fillStyle = '#F1B51C'; ctx.fillRect(0, hh, W, f(4));
  const badge = (cx, name, col) => {
    const r = hh * 0.34;
    ctx.beginPath(); ctx.arc(cx, hh / 2, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    t(abbr(name), cx, hh / 2 + f(1), r / s * 0.62, '#0C1511', 900, 'center');
  };
  const padX = f(64), r0 = hh * 0.34, maxN = W * 0.5 - padX - r0 * 2 - f(18) - f(150);
  const fit = (str, size) => { ctx.font = `800 ${Math.round(f(size))}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`; str = String(str); while (str.length > 3 && ctx.measureText(str).width > maxN) str = str.slice(0, -2).trimEnd() + '\u2026'; return str; };
  badge(padX + r0, d.us, GRN); t(fit(d.us, 30), padX + r0 * 2 + f(18), hh / 2, 30, INK, 800, 'left');
  badge(W - padX - r0, d.them, CLY); t(fit(d.them, 30), W - padX - r0 * 2 - f(18), hh / 2, 30, INK, 800, 'right');
  t(d.title || 'MATCH STATS', W / 2, hh / 2 - f(8), 22, '#F1B51C', 800, 'center');
  if (d.sub) t(d.sub, W / 2, hh / 2 + f(16), 16, MUT, 600, 'center');
  let strip = 0;
  if (d.scorers) {
    strip = f(44); const sy = hh + f(4) + strip / 2 + f(6);
    t(d.scorers.us.length ? d.scorers.us.join('  ') : '', padX, sy, 20, MUT, 700, 'left');
    t('GOALS', W / 2, sy, 15, '#5E7066', 800, 'center');
    t(d.scorers.them.length ? d.scorers.them.join('  ') : '', W - padX, sy, 20, MUT, 700, 'right');
  }
  const rows = d.rows || [], top = hh + f(24) + strip, avail = H - top - f(20), rh = avail / Math.max(1, rows.length);
  const bx0 = padX, bx1 = W - padX, bw = bx1 - bx0, bh = Math.max(f(8), rh * 0.11);
  rows.forEach(([label, a, b], i) => {
    const cy = top + rh * i + rh / 2;
    t(String(a), bx0, cy - rh * 0.16, 34, INK, 900, 'left');
    t(String(b), bx1, cy - rh * 0.16, 34, INK, 900, 'right');
    t(label, W / 2, cy - rh * 0.16, 22, MUT, 700, 'center');
    const tot = a + b, real = tot ? a / tot : 0.5, share = 0.5 + (real - 0.5) * prog, y = cy + rh * 0.2, gap = f(5);
    const ua = Math.max(0, bw * share - gap / 2), tb = Math.max(0, bw * (1 - share) - gap / 2);
    ctx.fillStyle = tot ? GRN : '#25352C'; rr(ctx, bx0, y, Math.max(f(4), ua), bh, bh / 2); ctx.fill();
    ctx.fillStyle = tot ? CLY : '#25352C'; rr(ctx, bx1 - Math.max(f(4), tb), y, Math.max(f(4), tb), bh, bh / 2); ctx.fill();
  });
  ctx.restore();
}

// clips: [{ start, end, kind:'goal'|'other', label, side, goalAt, before:{us,them}, after:{us,them} }]
export async function makeHighlightsVideo(file, { clips, us, them, title = 'Highlights', dateText = '', finalScore = null,
  scoreboard = true, sbPos = 'tl', stats = null,
  width = 1280, fps = 30, onProgress = () => {}, signal } = {}) {
  const mime = pickMime();
  if (!mime) throw new Error("This browser can't record video. Try Chrome or Edge on a computer.");
  if (!clips || !clips.length) throw new Error('Nothing to export yet.');

  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none';
  v.src = url; document.body.appendChild(v);
  let ac = null, recorder = null, raf = 0, stopped = false;
  const cleanup = () => {
    stopped = true; cancelAnimationFrame(raf);
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
    try { v.pause(); } catch (_) {}
    v.removeAttribute('src'); try { v.load(); } catch (_) {}
    v.remove(); URL.revokeObjectURL(url);
    if (ac) try { ac.close(); } catch (_) {}
    document.removeEventListener('visibilitychange', onVis);
  };
  const aborted = () => signal && signal.aborted;
  let paused = false;
  const onVis = () => {
    // browsers freeze canvas/video work in hidden tabs; hold the recording until the tab is back
    if (stopped) return;
    if (document.hidden) { paused = true; try { v.pause(); if (recorder && recorder.state === 'recording') recorder.pause(); } catch (_) {} }
    else if (paused) { paused = false; try { if (recorder && recorder.state === 'paused') recorder.resume(); } catch (_) {} if (curClip) v.play().catch(() => {}); }
  };
  let curClip = null;

  try {
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("The video can't be read by this browser.")); });
    const vw = v.videoWidth || 1280, vh = v.videoHeight || 720;
    const W = Math.min(width, vw) & ~1, H = Math.round(W * vh / vw) & ~1;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const k = W / 1280;                                   // everything is designed at 1280 wide
    const stream = cv.captureStream(fps);

    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaElementSource(v);
      const dest = ac.createMediaStreamDestination();
      src.connect(dest);                                  // not connected to the speakers: export is silent
      if (ac.resume) await ac.resume();
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    } catch (_) { ac = null; }

    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(3500000 * Math.max(.6, k)), audioBitsPerSecond: 128000 });
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped$ = new Promise(r => recorder.onstop = r);
    recorder.start(1000);
    document.addEventListener('visibilitychange', onVis);

    // ---- planned length, for the progress bar
    const INTRO = 2.6, OUTRO = 3.2, STATS = stats ? 8 : 0;
    const total = INTRO + OUTRO + STATS + clips.reduce((s, c) => s + (c.end - c.start), 0);
    let done = 0;
    const report = (extra = 0) => onProgress({ frac: Math.min(1, (done + extra) / total), done: done + extra, total });

    // ---- drawing
    const text = (t, x, y, size, color, weight = 800, align = 'left') => {
      ctx.font = `${weight} ${Math.round(size * k)}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
      ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(t, x * k, y * k);
    };
    const scorebug = (score, flash) => {
      const h = 52, nameW = 78, numW = 50;
      const total = nameW * 2 + numW * 2 + 6;
      const x = sbPos === 'tr' ? 1280 - 36 - total : 36, y = 34;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 12 * k;
      rr(ctx, x * k, y * k, total * k, h * k, 10 * k); ctx.fillStyle = NAVY; ctx.fill(); ctx.restore();
      // numbers
      const nx1 = x + nameW, nx2 = x + nameW + numW + 6;
      ctx.fillStyle = flash ? YEL : WHITE; ctx.fillRect(nx1 * k, y * k, numW * k, h * k); ctx.fillRect(nx2 * k, y * k, numW * k, h * k);
      ctx.fillStyle = 'rgba(11,31,58,.18)'; ctx.fillRect((nx2 - 3) * k, y * k, 6 * k, h * k);
      text(abbr(us), x + nameW / 2, y + h / 2, 22, WHITE, 800, 'center');
      text(abbr(them), x + nameW + numW * 2 + 6 + nameW / 2, y + h / 2, 22, WHITE, 800, 'center');
      text(String(score.us), nx1 + numW / 2, y + h / 2 + 1, 30, NAVY, 900, 'center');
      text(String(score.them), nx2 + numW / 2, y + h / 2 + 1, 30, NAVY, 900, 'center');
      // accent strip under the bug
      ctx.fillStyle = YEL; ctx.fillRect(x * k, (y + h) * k, total * k, 4 * k);
    };
    const banner = (clip, t, sinceGoal) => {
      // lower-third that slides in when the goal goes in
      const a = ease(sinceGoal / 0.45), out = ease((sinceGoal - 4.4) / 0.5);
      const slide = (1 - a) * 520 + out * 520;
      const x = 36 - slide, y = 590, h = 84;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 16 * k;
      ctx.fillStyle = YEL; ctx.fillRect(x * k, y * k, 190 * k, h * k);
      ctx.fillStyle = NAVY; ctx.fillRect((x + 190) * k, y * k, 560 * k, h * k); ctx.restore();
      text('GOAL!', x + 95, y + h / 2 + 1, 38, NAVY, 900, 'center');
      const who = clip.side === 'us' ? us : clip.side === 'them' ? them : '';
      if (who) text(who.toUpperCase(), x + 214, y + 28, 24, YEL, 800);
      const sc = clip.after ? `${abbr(us)} ${clip.after.us} – ${clip.after.them} ${abbr(them)}` : '';
      text(sc, x + 214, y + 60, 30, WHITE, 900);
    };
    const tag = (clip, a) => {
      if (!clip.label) return;
      ctx.save(); ctx.globalAlpha = a;
      const label = clip.label.toUpperCase(); ctx.font = `800 ${Math.round(20 * k)}px system-ui, Arial, sans-serif`;
      const w = ctx.measureText(label).width / k + 36;
      rr(ctx, 36 * k, 640 * k, w * k, 38 * k, 8 * k); ctx.fillStyle = 'rgba(11,31,58,.88)'; ctx.fill();
      text(label, 54, 659, 20, WHITE, 800); ctx.restore();
    };
    const drawVideo = () => { try { ctx.drawImage(v, 0, 0, W, H); } catch (_) {} };
    const card = (kind, p) => {
      if (kind === 'stats') return drawStats(ctx, W, H, stats, ease(p / 1.6));
      const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0B1F3A'); g.addColorStop(1, '#14804A');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,.06)'; for (let i = 0; i < 8; i++) ctx.fillRect(0, (i * 90 + 18) * k, W, 44 * k);
      const a = ease(p / 0.5);
      ctx.save(); ctx.globalAlpha = a;
      if (kind === 'intro') {
        text(title.toUpperCase(), 640, 255, 30, YEL, 800, 'center');
        text(`${us}  v  ${them}`, 640, 345, 62, WHITE, 900, 'center');
        if (dateText) text(dateText, 640, 420, 26, 'rgba(255,255,255,.8)', 600, 'center');
        if (finalScore) text(`FULL TIME  ${finalScore.us} – ${finalScore.them}`, 640, 500, 34, YEL, 800, 'center');
      } else {
        text('FULL TIME', 640, 250, 30, YEL, 800, 'center');
        if (finalScore) text(`${abbr(us)}  ${finalScore.us} – ${finalScore.them}  ${abbr(them)}`, 640, 350, 84, WHITE, 900, 'center');
        text(`${us} v ${them}`, 640, 440, 28, 'rgba(255,255,255,.85)', 600, 'center');
        text('Made with Pitchside', 640, 640, 20, 'rgba(255,255,255,.6)', 600, 'center');
      }
      ctx.restore();
    };
    const frameLoop = fn => new Promise((resolve, reject) => {
      const step = () => {
        if (aborted()) return reject(new DOMException('Cancelled', 'AbortError'));
        if (!paused) { const r = fn(); if (r === true) return resolve(); }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
    const playCard = async (kind, secs) => {
      const t0 = performance.now(); let lastTick = t0, acc = 0;
      await frameLoop(() => {
        const now = performance.now(); if (!paused) acc += (now - lastTick) / 1000; lastTick = now;
        card(kind, acc); report(acc); return acc >= secs;
      });
      done += secs;
    };
    const waitSeek = t => new Promise(res => { const h = () => { v.removeEventListener('seeked', h); res(); }; v.addEventListener('seeked', h); v.currentTime = t; setTimeout(res, 4000); });

    // ---- run
    await playCard('intro', INTRO);
    for (const clip of clips) {
      curClip = clip;
      await waitSeek(clip.start); v.playbackRate = 1;
      await v.play();
      const len = clip.end - clip.start;
      await frameLoop(() => {
        const t = v.currentTime, into = t - clip.start;
        drawVideo();
        const isGoal = clip.kind === 'goal' && clip.goalAt != null;
        const past = isGoal && t >= clip.goalAt;
        const score = isGoal ? (past ? clip.after : clip.before) : (clip.after || clip.before || { us: 0, them: 0 });
        if (scoreboard) scorebug(score || { us: 0, them: 0 }, isGoal && past && t - clip.goalAt < 1.2);
        if (isGoal && past) banner(clip, t, t - clip.goalAt); else if (!isGoal) tag(clip, Math.min(1, into / 0.3));
        if (into < 0.3) { ctx.fillStyle = `rgba(0,0,0,${1 - into / 0.3})`; ctx.fillRect(0, 0, W, H); }
        const rem = clip.end - t; if (rem < 0.3) { ctx.fillStyle = `rgba(0,0,0,${1 - rem / 0.3})`; ctx.fillRect(0, 0, W, H); }
        report(Math.max(0, Math.min(len, into)));
        return t >= clip.end || v.ended;
      });
      v.pause(); done += len; curClip = null;
    }
    if (stats) await playCard('stats', STATS);
    await playCard('outro', OUTRO);
    await new Promise(r => setTimeout(r, 250));
    try { recorder.stop(); } catch (_) {}
    await stopped$;
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    onProgress({ frac: 1, done: total, total });
    return { blob, ext, mime: blob.type, seconds: total, width: W, height: H, hasAudio: !!ac };
  } finally { cleanup(); }
}
