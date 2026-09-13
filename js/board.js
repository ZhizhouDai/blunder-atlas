// Minimalist click-to-move chess board. Renders from a chess.js instance and
// reports user moves via onMove({from,to,promotion,san,uci}).
//
// Supports a "preview" mode (showPreview/clearPreview) that temporarily
// displays a different FEN with custom arrows — used to scrub through saved
// move history — without touching the live game state.

const PIECE_SRC = {
  wp: 'lib/pieces/wP.svg', wn: 'lib/pieces/wN.svg', wb: 'lib/pieces/wB.svg',
  wr: 'lib/pieces/wR.svg', wq: 'lib/pieces/wQ.svg', wk: 'lib/pieces/wK.svg',
  bp: 'lib/pieces/bP.svg', bn: 'lib/pieces/bN.svg', bb: 'lib/pieces/bB.svg',
  br: 'lib/pieces/bR.svg', bq: 'lib/pieces/bQ.svg', bk: 'lib/pieces/bK.svg',
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

class Board {
  constructor(container, { onMove, interactive = true, onPositionChange } = {}) {
    this.container = container;
    this.onMove = onMove;
    this.onPositionChange = onPositionChange;
    this.interactive = interactive;
    this.orientation = 'w';
    this.chess = new Chess();
    this.selected = null;
    this.legalTargets = [];
    this.lastMove = null; // {from,to}
    this.previewChess = null;
    this.previewArrows = null;
    this.squares = {};
    this._buildDom();
  }

  _buildDom() {
    this.container.innerHTML = '';
    this.el = document.createElement('div');
    this.el.className = 'board';
    this.container.appendChild(this.el);
  }

  setPosition(fen, orientation) {
    this.chess = new Chess(fen);
    this.orientation = orientation || 'w';
    this.selected = null;
    this.legalTargets = [];
    this.lastMove = null;
    this.previewChess = null;
    this.previewArrows = null;
    this._render({ animate: false });
  }

  applyUci(uci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const applied = this.chess.move({ from, to, promotion });
    if (applied) {
      this.selected = null;
      this.legalTargets = [];
      this.lastMove = { from, to };
      this._render({ animate: true });
    }
    return applied;
  }

  // Temporarily displays `fen` with a custom set of arrows
  // ([{from,to,kind}]) instead of the live game state. Blocks interaction
  // until clearPreview() is called.
  showPreview(fen, arrows) {
    this.previewChess = new Chess(fen);
    this.previewArrows = arrows || [];
    this._render({ animate: false });
  }

  clearPreview() {
    this.previewChess = null;
    this.previewArrows = null;
    this._render({ animate: false });
  }

  get isPreviewing() {
    return !!this.previewChess;
  }

  _squareOrder() {
    const ranks = this.orientation === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = this.orientation === 'w' ? FILES : [...FILES].reverse();
    const order = [];
    for (const r of ranks) for (const f of files) order.push(`${f}${r}`);
    return order;
  }

  _render(opts) {
    const animate = !!(opts && opts.animate) && !this.previewChess && this.lastMove;

    this.el.innerHTML = '';
    this.squares = {};
    const activeChess = this.previewChess || this.chess;
    const board = activeChess.board(); // 8x8 array, row0 = rank8
    const pieceAt = {};
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board[r][f];
        if (cell) {
          const sq = `${FILES[f]}${8 - r}`;
          pieceAt[sq] = cell.color + cell.type;
        }
      }
    }

    const arrows = this.previewArrows !== null
      ? this.previewArrows
      : (this.lastMove ? [{ from: this.lastMove.from, to: this.lastMove.to, kind: 'last' }] : []);
    const arrowSquares = new Set();
    arrows.forEach((a) => { arrowSquares.add(a.from); arrowSquares.add(a.to); });

    const order = this._squareOrder();
    order.forEach((sq, idx) => {
      const file = FILES.indexOf(sq[0]);
      const rank = parseInt(sq[1], 10);
      const isLight = (file + rank) % 2 === 1;
      const div = document.createElement('div');
      div.className = 'square ' + (isLight ? 'light' : 'dark');
      div.dataset.square = sq;

      if (!this.previewChess && arrowSquares.has(sq)) {
        div.classList.add('last-move');
      }
      if (this.selected === sq) div.classList.add('selected');
      if (this.legalTargets.includes(sq)) div.classList.add('legal-target');

      const piece = pieceAt[sq];
      if (piece) {
        const img = document.createElement('img');
        img.className = 'piece';
        img.draggable = false;
        img.alt = '';
        img.src = PIECE_SRC[piece];
        div.appendChild(img);
      }

      // file/rank coordinate labels on the edges
      const isBottomRow = idx >= 56;
      const isLeftCol = idx % 8 === 0;
      if (isBottomRow) {
        const lbl = document.createElement('span');
        lbl.className = 'coord coord-file';
        lbl.textContent = sq[0];
        div.appendChild(lbl);
      }
      if (isLeftCol) {
        const lbl = document.createElement('span');
        lbl.className = 'coord coord-rank';
        lbl.textContent = sq[1];
        div.appendChild(lbl);
      }

      if (this.interactive) {
        div.addEventListener('click', () => this._handleClick(sq));
      }
      this.squares[sq] = div;
      this.el.appendChild(div);
    });

    if (arrows.length) this._renderArrows(arrows);

    if (animate) this._animatePieceSlide(this.lastMove.from, this.lastMove.to);

    const currentFen = activeChess.fen();
    if (this.onPositionChange && currentFen !== this._lastReportedFen) {
      this._lastReportedFen = currentFen;
      this.onPositionChange(currentFen);
    }
  }

  // Lightweight FLIP animation. Squares don't move between renders (same
  // grid, same size) — only piece occupancy changes — so the "before"
  // position is simply the from-square's current rect, no pre-capture needed.
  _animatePieceSlide(fromSquare, toSquare) {
    const fromDiv = this.squares[fromSquare];
    const toDiv = this.squares[toSquare];
    const img = toDiv && toDiv.querySelector('img.piece');
    if (!img || !fromDiv) return;
    const fromRect = fromDiv.getBoundingClientRect();
    const toRect = toDiv.getBoundingClientRect();
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    if (!dx && !dy) return;
    img.style.transition = 'none';
    img.style.transform = `translate(${dx}px, ${dy}px)`;
    // Force layout so the browser registers the start position before we
    // animate to the resting transform.
    void img.getBoundingClientRect();
    requestAnimationFrame(() => {
      img.style.transition = 'transform 0.2s ease';
      img.style.transform = '';
    });
  }

  _squareCenterPercent(sq) {
    const fileIdx = FILES.indexOf(sq[0]);
    const rank = parseInt(sq[1], 10);
    let col, row;
    if (this.orientation === 'w') {
      col = fileIdx;
      row = 8 - rank;
    } else {
      col = 7 - fileIdx;
      row = rank - 1;
    }
    return { x: (col + 0.5) * 12.5, y: (row + 0.5) * 12.5 };
  }

  // Draws every arrow into a single shared SVG overlay (one element, one
  // viewBox) rather than one <svg> per arrow — simpler and more robust.
  _renderArrows(arrows) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'board-arrow-layer');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', 'none');

    arrows.forEach(({ from, to, kind }) => {
      if (from === to) return; // nothing meaningful to draw
      const shapes = this._arrowShapes(from, to);
      if (!shapes) return;

      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', shapes.x1);
      line.setAttribute('y1', shapes.y1);
      line.setAttribute('x2', shapes.x2);
      line.setAttribute('y2', shapes.y2);
      line.setAttribute('class', `board-arrow-line arrow-${kind || 'last'}`);
      svg.appendChild(line);

      const head = document.createElementNS(svgNS, 'polygon');
      head.setAttribute('points', shapes.headPoints);
      head.setAttribute('class', `board-arrow-head arrow-${kind || 'last'}`);
      svg.appendChild(head);
    });

    this.el.appendChild(svg);
  }

  // Pure geometry: given two square names, returns the line endpoints and
  // arrowhead triangle points in the board's 0-100 coordinate space.
  _arrowShapes(from, to) {
    const a = this._squareCenterPercent(from);
    const b = this._squareCenterPercent(to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!len) return null;
    const ux = dx / len;
    const uy = dy / len;

    const headLen = Math.min(4.4, len * 0.4);
    const headWidth = Math.min(2.8, len * 0.25);
    const tipX = b.x - ux * 1.2;
    const tipY = b.y - uy * 1.2;
    const baseX = tipX - ux * headLen;
    const baseY = tipY - uy * headLen;
    const leftX = baseX - uy * headWidth;
    const leftY = baseY + ux * headWidth;
    const rightX = baseX + uy * headWidth;
    const rightY = baseY - ux * headWidth;

    return {
      x1: a.x, y1: a.y, x2: baseX, y2: baseY,
      headPoints: `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`,
    };
  }

  _handleClick(sq) {
    if (this.previewChess) return; // interaction disabled while previewing
    const piece = this.chess.get(sq);
    if (this.selected) {
      if (this.legalTargets.includes(sq)) {
        this._attemptMove(this.selected, sq);
        return;
      }
      if (piece && piece.color === this.chess.turn()) {
        this._select(sq);
        return;
      }
      this.selected = null;
      this.legalTargets = [];
      this._render();
      return;
    }
    if (piece && piece.color === this.chess.turn()) {
      this._select(sq);
    }
  }

  _select(sq) {
    this.selected = sq;
    const moves = this.chess.moves({ square: sq, verbose: true });
    this.legalTargets = moves.map((m) => m.to);
    this._render();
  }

  _attemptMove(from, to) {
    const moves = this.chess.moves({ square: from, verbose: true });
    const match = moves.find((m) => m.to === to);
    let promotion;
    if (match && match.flags.includes('p')) {
      promotion = 'q'; // auto-queen; good enough for tactics puzzles
    }
    const uci = from + to + (promotion || '');
    this.selected = null;
    this.legalTargets = [];
    this._render();
    if (this.onMove) this.onMove({ from, to, promotion, uci });
  }
}
