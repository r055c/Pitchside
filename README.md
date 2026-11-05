# Pitchside

Turn a football match recording into highlights and stats. Runs entirely in the browser: the video never leaves your device. No AI service, no cost.

## How it works
1. Pick a match video, then name the teams.
2. Find highlights: ask Gemini, or use crowd noise, whistles, the ball tracker or the scoreboard.
3. Review highlights: check each one (goal, shot, corner, save, foul; us or them), with a Sky-style stats graphic.
4. Export: goals only or all highlights, with or without a scoreboard, then make the video.

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


## Track the ball (beta)

An optional way to find goals with no tagging: a football ball detector (an `.onnx` model file) runs in your browser
using ONNX Runtime Web (WebGPU where available, otherwise the CPU, which is very slow). Pitchside tracks the ball through
the match and reports a goal when the ball reaches a goal area and then sits still on the centre spot (the kick-off).
Shots and saves with no kick-off after them are listed as "maybe".

- Needs the hosted version (the Vercel address). `Pitchside.html` (the single file) shows a message instead, because the
  runtime files live in `js/vendor/ort/`.
- Load the model once on the setup screen; it is kept on the device. A suitable open model:
  https://huggingface.co/acatorcini/yolov9-soccer-ball (`v9b_best.onnx`, AGPL-3.0).
- The goal and centre-spot boxes are guessed from where the ball travels; drag new boxes if they are wrong.
- `js/ball.js` has the logic. `colab/Pitchside_ball_finder.ipynb` runs the same idea on a free Colab GPU.
- `js/vendor/ort/` is ONNX Runtime Web 1.22.0 (MIT licence).


## Smart goal finder (beta)

Combines every clue into one ranked list and, when you give the final score, keeps exactly that many goals.
Clues: crowd noise (the match scan), the scoreboard reader, the ball tracker, **cheering and whistles**
(Google YAMNet sound classifier, `js/sound.js`) and **spoken "goal"** (Whisper tiny English, `js/speech.js`).

- Open it from the Find highlights step. Every clue is optional; more clues means better answers.
- `js/audio.js` reads the match sound in about a minute with the browser's own decoder (Chrome/Edge, `.mp4` or `.mov`).
- The two sound models download once from Hugging Face by the browser (YAMNet is kept in the Cache API; Whisper is cached
  by the library). If Hugging Face is blocked, choose `yamnet.onnx` yourself:
  https://huggingface.co/audiomagic/yamnet-onnx (Apache-2.0).
- `js/fuse.js` is the combining logic. Hosted version only: `js/vendor/` holds ONNX Runtime Web, mp4box.js (BSD-3) and
  Transformers.js (Apache-2.0) so nothing is fetched from a CDN.

## Ask Gemini (beta)
(Updated: Gemini now also reads the score after each goal, re-checks the stretches where the score says a goal is missing, takes a closer look at each goal for the exact second, flags anything that disagrees with the final score, and can optionally list shots, saves, corners and fouls. For hosting with the key on the server, see `worker/README.md`.)

In the Smart goal finder, paste your own free key from https://aistudio.google.com/apikey. The browser uploads the match video straight to Google (File API), asks Gemini for the goals in 15-minute parts, then deletes the upload. The answer joins the other clues. The key is only kept on the device if you tick "Remember". Free-tier limits may slow it down; it waits and retries.
