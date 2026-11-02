# Pitchside

Turn a football match recording into highlights and stats. Runs entirely in the browser: the video never leaves your device. No AI service, no cost.

## How it works
1. Pick a match video, then name the teams.
2. The app scans it quickly and silently, using crowd noise, whistles and camera movement to find likely moments.
3. Review the moments and tag them (goal, shot, corner, save, foul; us or them).
4. Summary tab: score, match-flow chart, head-to-head stats. Moments tab: replayable highlight reel.

## Run it
- **Easiest (no server):** double-click `Pitchside.html` in Chrome or Edge.
- **As an installable PWA:** serve this folder over HTTP(S), e.g. `python3 -m http.server 8000`, then open `http://localhost:8000`.

`Pitchside.html` is generated from the other files: `python3 build_single.py`.

## Status
Tested end to end in headless Chrome on a synthetic match video. Not yet tested on a real iPhone or real match footage.

## Layout
- `index.html`, `css/app.css`, `js/app.js` (UI), `js/analysis.js` (scan and moment detection), `js/db.js` (IndexedDB)
- `sw.js`, `manifest.webmanifest`, `icons/` (PWA)
