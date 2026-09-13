# Blunder Atlas

A local, private puzzle trainer built from your own Chess.com mistakes. Everything
runs in your browser — your games and puzzles are stored locally (IndexedDB) and
never leave your machine except for the read-only fetch to Chess.com's public API.

## Running it

This app lives at `C:\Users\sgdfj\Desktop\BlunderAtlas`. No Node or Python needed.

**Easiest way:** double-click **`Start Blunder Atlas.bat`** in this folder.

Or from a terminal in this folder:

```powershell
powershell -ExecutionPolicy Bypass -File server.ps1
```

Then open **http://localhost:8843** in your browser on this PC. Leave the
terminal/console window open while you use the app; closing it stops the
server.

(To use a different port: `powershell -ExecutionPolicy Bypass -File server.ps1 -Port 9000`)

### Using it from your phone

The server listens on your whole local network, not just this PC. While it's
running, on a phone or other device connected to the **same Wi-Fi**, open:

**http://192.168.12.104:8843** *(this PC's current network address — it can
change if your router reassigns it; re-run the server and check the console
output for the current one if this stops working)*

This only works while your PC is on, the server is running, and both devices
are on the same network — it won't work over cellular data or away from home.

The first time a phone connects, Windows might show a **Windows Defender
Firewall** prompt asking to allow the connection — click **Allow access**. If
you don't see a prompt and it just doesn't load, you may need to allow it
manually: open an **elevated** PowerShell and run:

```powershell
netsh advfirewall firewall add rule name="Blunder Atlas" dir=in action=allow protocol=TCP localport=8843
```

(I didn't run this myself — firewall changes are a system security setting,
so that one's up to you.)

**Heads up on data:** puzzles and practice history are stored locally in each
browser (IndexedDB) — there's no shared server-side database. That means your
phone and your PC keep **completely separate libraries**: importing games on
your phone won't show up on your PC and vice versa. Each device is its own
independent copy of the app.

## How it works

1. **Import** — enter your Chess.com username; the app pulls your recent games
   via Chess.com's public API (no login required).
2. **Analyze** — [Stockfish 18](https://stockfishchess.org/) (the current NNUE
   engine, single-threaded WASM build, running locally in your browser via a
   Web Worker — nothing is sent to a server) replays every move you made and
   flags inaccuracies, mistakes, and blunders by centipawn loss (≥50 / ≥100 /
   ≥300 respectively, skipping positions that are already decided).
3. **Puzzles** — each flagged move becomes a puzzle: the position right
   before your mistake, with the engine's best continuation (up to 8 plies)
   as the solution.
4. **Practice** — solve puzzles on the board (click a piece, click a
   destination); the app auto-plays the opponent's best replies. If you play
   a wrong move, it's simply flagged as wrong — the move is committed for
   real and the engine replies, so you can keep playing and see for yourself
   what goes wrong. That whole side-line can be saved ("Save this line")
   under **Explored lines** on the puzzle, revisited anytime, or deleted.
   Bookmark, label (e.g. "hanging piece", "missed fork"), delete, or give up
   and reveal the solution.
5. **History** — track which puzzles you've solved, attempted but not
   solved, or never touched, broken down by severity and label. Click any
   entry in "Recent activity" to jump straight back into that puzzle.
6. **Piece style** — pick from five sets (Classic, Merida, Alpha, Leipzig,
   California) via the dropdown in the top bar; the choice is remembered.

## Notes

- Analysis speed is adjustable (Fast / Balanced / Deep) — deeper search is
  more accurate but slower. You can cancel an import mid-run; games already
  analyzed keep their puzzles.
- Only standard chess games are analyzed (variants like Chess960 are skipped).
- Re-importing skips games you've already analyzed.
- The engine ships as a ~7MB WASM file (`lib/stockfish-18-lite-single.wasm`),
  vendored locally so the app works offline once loaded.
