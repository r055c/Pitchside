# Pitchside

Turn a football match recording into highlights and stats. Runs entirely in the browser: the video never leaves your device. No AI service, no cost.

## How it works
1. Pick a match video, then name the teams.
2. The app scans it quickly and silently, using crowd noise, whistles and camera movement to find likely moments.
3. Review the moments and tag them (goal, shot, corner, save, foul; us or them).
4. Summary tab: score, match-flow chart, head-to-head stats. Moments tab: replayable highlight reel.

## Making the highlights video
Goal times can come from four places: typed in (`12:34 Norton`), the "Goal here" buttons while watching, the Find goals button (uses the final score), or the scoreboard reader. **Make highlights video** then clips around each goal, adds a score graphic and GOAL banner, and records an MP4 (or WebM) in the browser.

## Scoreboard reader and learning
If the footage shows a scoreboard, mark the two score numbers before scanning. The scan records every change and offers them as goals. **Teach Pitchside** then learns what a goal sounds and looks like (crowd roar, lull, restart whistle) so Find goals works on footage with no scoreboard. Untested on real footage so far.

## Run it
- **Easiest (no server):** double-click `Pitchside.html` in Chrome or Edge.
- **As an installable PWA:** serve this folder over HTTP(S), e.g. `python3 -m http.server 8000`, then open `http://localhost:8000`.

`Pitchside.html` is generated from the other files: `python3 build_single.py`.

## Status
Tested end to end in headless Chrome on a synthetic match video. Not yet tested on a real iPhone or real match footage.

## Layout
- `index.html`, `css/app.css`, `js/app.js` (UI), `js/analysis.js` (scan and moment detection), `js/db.js` (IndexedDB)
- `sw.js`, `manifest.webmanifest`, `icons/` (PWA)
