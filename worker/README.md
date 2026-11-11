# Moving Ask Gemini to Cloudflare (key stays on the server)

Right now each person pastes their own Gemini key into the app. When Pitchside lives on Cloudflare you can keep **one key on the server** instead, so nobody has to handle a key at all.

1. Host the app on Cloudflare Pages as normal.
2. Deploy `gemini-proxy.js` as a Worker routed to `your-site/api/gemini/*` (see `wrangler.toml`).
3. Add the key as a secret: `npx wrangler secret put GEMINI_API_KEY`.
4. Optional: `npx wrangler secret put PASSCODE` and tell your players the code. They enter it once in the app ("Remember the access code"). Without a passcode anyone who finds the site could spend your free quota, so keep the passcode on unless the site is private (Cloudflare Access also works).
5. In `index.html` add inside `<head>`: `<meta name="pitchside-gemini-proxy" content="/api/gemini">`

With that meta tag the Ask Gemini box asks for the access code instead of a key. Everything else works the same.

How the 200 MB video gets there: the Worker only handles small requests. Starting an upload goes through it, and Google answers with a one-off upload address, so the browser sends the video straight to Google. The key is never in the browser.

Never put the key in the repository or the page code. Google disables keys found in public repositories.

## On Vercel instead
`api/gemini.js` (plus the rewrite in `vercel.json`) is the same proxy as a Vercel Edge Function, so no Worker is needed. In Vercel, open the project, then Settings > Environment Variables, and add `GEMINI_API_KEY` (your key) and `PASSCODE` (any code you choose). Then redeploy. `index.html` already carries the `pitchside-gemini-proxy` meta tag, so the hosted app asks for the access code instead of a key. The single-file `Pitchside.html` leaves the tag out, because it has no server to go through.
