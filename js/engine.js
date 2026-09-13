// Thin wrapper around Stockfish 18 (NNUE, single-threaded lite WASM build) running in a Web Worker.
// Serializes analysis requests (one at a time) via an internal queue.
class Engine {
  constructor() {
    this.worker = null;
    this.ready = null;
    this._queue = Promise.resolve();
  }

  init() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      try {
        this.worker = new Worker('lib/stockfish-18-lite-single.js');
      } catch (err) {
        reject(err);
        return;
      }
      const onMsg = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (line === 'uciok') {
          this.worker.postMessage('isready');
        } else if (line === 'readyok') {
          this.worker.removeEventListener('message', onMsg);
          resolve();
        }
      };
      this.worker.addEventListener('message', onMsg);
      this.worker.onerror = (err) => reject(err);
      this.worker.postMessage('uci');
    });
    return this.ready;
  }

  // Runs one analysis at a time; queues concurrent calls.
  analyze(fen, { movetimeMs = 500 } = {}) {
    const run = () => this._analyzeOne(fen, movetimeMs);
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  async _analyzeOne(fen, movetimeMs) {
    await this.init();
    return new Promise((resolve, reject) => {
      let lastInfo = null;
      const onMsg = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (line.startsWith('info') && line.includes(' pv ')) {
          // Skip aspiration-window fail-high/low lines: their score/PV are
          // provisional (PV is often truncated to a single move).
          if (line.includes(' lowerbound') || line.includes(' upperbound')) return;
          const parsed = parseInfoLine(line);
          if (parsed) lastInfo = parsed;
        } else if (line.startsWith('bestmove')) {
          this.worker.removeEventListener('message', onMsg);
          const parts = line.split(' ');
          const bestMoveUci = parts[1] === '(none)' ? null : parts[1];
          resolve({
            bestMoveUci,
            scoreCp: lastInfo ? lastInfo.scoreCp : 0,
            mate: lastInfo ? lastInfo.mate : null,
            pvUci: lastInfo ? lastInfo.pv : (bestMoveUci ? [bestMoveUci] : []),
          });
        }
      };
      this.worker.addEventListener('message', onMsg);
      this.worker.postMessage('ucinewgame');
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go movetime ${movetimeMs}`);
    });
  }
}

function parseInfoLine(line) {
  const tokens = line.split(' ');
  let scoreCp = null;
  let mate = null;
  let pv = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'score') {
      if (tokens[i + 1] === 'cp') {
        scoreCp = parseInt(tokens[i + 2], 10);
      } else if (tokens[i + 1] === 'mate') {
        mate = parseInt(tokens[i + 2], 10);
        scoreCp = mate > 0 ? 100000 - mate * 100 : -100000 - mate * 100;
      }
    } else if (tokens[i] === 'pv') {
      pv = tokens.slice(i + 1);
      break;
    }
  }
  if (scoreCp === null) return null;
  return { scoreCp, mate, pv };
}

const engine = new Engine();
