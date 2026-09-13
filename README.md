# Blunder Atlas

A puzzle trainer built from your own Chess.com mistakes. Everything runs
entirely in your browser — the chess engine is WebAssembly, your puzzles are
stored locally (IndexedDB), and the only network calls are read-only fetches
to Chess.com's public API. There is no backend and no account system; nothing
about your games or puzzles is ever sent anywhere else.

## Use it now

**https://zhizhoudai.github.io/blunder-atlas/**

Works on any device with a modern browser — phone, tablet, laptop — with no
setup. Just open the link.

**Important:** puzzles and practice history are stored per-browser
(IndexedDB), not in a shared account. Opening this same link on your phone
and on your PC gives you **two separate, independent libraries** — importing
games on one device does not show up on the other. This is a deliberate
trade-off for keeping everything private and server-free.

## How it works

1. **Import** — enter your Chess.com username once; the app pulls your
   recent games via Chess.com's public API (no login required) and remembers
   the username after that.
2. **Auto-check** — from then on, every time you open the app it silently
   checks Chess.com for games played since your last visit and analyzes
   anything new — no button click needed. It's throttled to at most once
   every 15 minutes and analyzes at most 5 new games per check (so opening
   the app after a long gap can't turn into a multi-minute background job);
   any leftover games are simply still "new" and get picked up on the next
   check. Every game is keyed by Chess.com's own game ID, so a game is never
   analyzed twice no matter how many times a scan runs. The manual **Import**
   button still works too, for a specific date range or analysis depth.
3. **Analyze** — [Stockfish 18](https://stockfishchess.org/) (the current
   NNUE engine, single-threaded WASM build, running locally via a Web
   Worker) replays every move you made and flags inaccuracies, mistakes, and
   blunders by centipawn loss (≥50 / ≥100 / ≥300 respectively, skipping
   positions that are already decided).
4. **Puzzles** — each flagged move becomes a puzzle: the position right
   before your mistake, with the engine's best continuation (up to 8 plies)
   as the solution.
5. **Practice** — solve puzzles on the board (click a piece, click a
   destination); the app auto-plays the opponent's best replies. If you play
   a wrong move, it's simply flagged as wrong — the move is committed for
   real and the engine replies, so you can keep playing and see for yourself
   what goes wrong. That whole side-line can be saved ("Save this line")
   under **Explored lines** on the puzzle, revisited anytime, or deleted.
   Bookmark, label (e.g. "hanging piece", "missed fork"), delete, or give up
   and reveal the solution.
6. **History** — track which puzzles you've solved, attempted but not
   solved, or never touched, broken down by severity and label. Click any
   entry in "Recent activity" to jump straight back into that puzzle.

## Notes

- Analysis speed is adjustable (Fast / Balanced / Deep) for manual imports —
  deeper search is more accurate but slower. You can cancel an import
  mid-run; games already analyzed keep their puzzles.
- Only standard chess games are analyzed (variants like Chess960 are
  skipped).
- The engine ships as a ~7MB WASM file, loaded once and cached by your
  browser after that.

## Running a local copy instead

You don't need this for normal use — the hosted link above works everywhere.
This is only for running fully offline or working on the code.

This folder has everything needed; no Node or Python required.

**Easiest way:** double-click **`Start Blunder Atlas.bat`**.

Or from a terminal in this folder:

```powershell
powershell -ExecutionPolicy Bypass -File server.ps1
```

Then open **http://localhost:8843**. Leave the terminal window open while
you use the app; closing it stops the server. (Different port: add
`-Port 9000`.)

The local server also listens on your whole local network, so a phone on the
**same Wi-Fi** can reach it at `http://<this-PC's-LAN-IP>:8843` — check the
server's console output for the current address. This only works while your
PC is on, the server is running, and both devices share a network; the
hosted link above doesn't have any of these restrictions.

## Updating the deployed site

The live site is a GitHub Pages deployment of this repo
(`ZhizhouDai/blunder-atlas`, `master` branch, served from `/`). Push changes
to `master` and GitHub rebuilds the Pages site automatically (usually live
within a minute or two).
