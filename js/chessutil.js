// Small chess.js-adjacent helpers shared by analyze.js and board.js.
// Uses chess.js 0.13.x API (snake_case methods).

function parseUci(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  };
}

function stripCheckMarks(san) {
  return san.replace(/[+#]/g, '');
}

// Replays a UCI move list from a starting FEN, returning SAN strings and the
// resulting FEN after each ply. Stops early if a move is illegal/unparseable.
function replayUciLine(fen, uciList, maxPlies) {
  const chess = new Chess(fen);
  const sanList = [];
  const uciTrimmed = [];
  const fensAfter = [];
  const limit = Math.min(maxPlies, uciList.length);
  for (let i = 0; i < limit; i++) {
    const mv = parseUci(uciList[i]);
    const applied = chess.move(mv);
    if (!applied) break;
    sanList.push(applied.san);
    uciTrimmed.push(uciList[i]);
    fensAfter.push(chess.fen());
  }
  return { sanList, uciTrimmed, fensAfter };
}

// Returns the SAN of a single UCI move applied to a FEN, or null if illegal.
function uciToSanAt(fen, uci) {
  const chess = new Chess(fen);
  const applied = chess.move(parseUci(uci));
  return applied ? applied.san : null;
}
