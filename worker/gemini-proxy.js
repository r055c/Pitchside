// Pitchside Gemini proxy for Cloudflare Workers.
// Keeps your Gemini API key on the server so it never reaches anyone's browser.
//
// The browser sends small requests here (list models, start an upload, ask a question, delete the file). The big video
// upload does NOT come through here: Google's "start upload" reply contains a one-off upload address that already
// carries permission, so the browser sends the video straight to Google. That keeps the Worker within its size limits.
//
// Secrets (set with `wrangler secret put`):
//   GEMINI_API_KEY   required   the key from aistudio.google.com/apikey
//   PASSCODE         optional   if set, people must enter it in the app (sent as the X-Pitchside-Pass header)
// Route it on the same site as the app, e.g. example.com/api/gemini/*  (so no cross-site settings are needed).

const GOOGLE = 'https://generativelanguage.googleapis.com';
const PREFIX = '/api/gemini';
const ALLOWED = [/^\/v1beta\/models(\/[\w.\-]+(:generateContent)?)?$/, /^\/v1beta\/files\/[\w\-]+$/, /^\/upload\/v1beta\/files$/];
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;   // refuse to start an upload bigger than 1 GB

function same(a, b) {   // constant-time string compare
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
const json = (o, status) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX + '/')) return json({ error: { message: 'Not found' } }, 404);
    if (!env.GEMINI_API_KEY) return json({ error: { message: 'The server has no Gemini key set up yet.' } }, 500);
    if (env.PASSCODE && !same(request.headers.get('X-Pitchside-Pass') || '', env.PASSCODE)) return json({ error: { message: 'Wrong or missing access code.' } }, 401);

    const path = url.pathname.slice(PREFIX.length);
    if (!ALLOWED.some(r => r.test(path))) return json({ error: { message: 'That address is not allowed.' } }, 403);
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) return json({ error: { message: 'Method not allowed.' } }, 405);
    if (path === '/upload/v1beta/files' && Number(request.headers.get('X-Goog-Upload-Header-Content-Length') || 0) > MAX_UPLOAD_BYTES) return json({ error: { message: 'That video is too big.' } }, 413);

    const headers = new Headers();
    for (const h of ['content-type', 'x-goog-upload-protocol', 'x-goog-upload-command', 'x-goog-upload-header-content-length', 'x-goog-upload-header-content-type']) {
      const v = request.headers.get(h); if (v) headers.set(h, v);
    }
    headers.set('x-goog-api-key', env.GEMINI_API_KEY);
    const upstream = await fetch(GOOGLE + path + url.search, { method: request.method, headers, body: ['GET', 'DELETE'].includes(request.method) ? undefined : request.body });

    const out = new Headers();
    for (const h of ['content-type', 'x-goog-upload-url', 'x-goog-upload-status']) { const v = upstream.headers.get(h); if (v) out.set(h, v); }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
