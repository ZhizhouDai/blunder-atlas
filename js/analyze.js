// Turns imported chess.com games into classified mistakes and puzzle records.

const SEVERITY = {
  BLUNDER: 'blunder',
  MISTAKE: 'mistake',
  INACCURACY: 'inaccuracy',
};

const THRESHOLDS_CP = {
  [SEVERITY.INACCURACY]: 50,
  [SEVERITY.MISTAKE]: 100,
  [SEVERITY.BLUNDER]: 300,
};

const DECIDED_POSITION_CP = 1000; // skip flagging moves once the game is already clearly decided
const MAX_SOLUTION_PLIES = 8;

const SPEED_PRESETS = {
  fast: { movetimeMs: 250, followupMs: 150 },
  balanced: { movetimeMs: 500, followupMs: 250 },
  deep: { movetimeMs: 1000, followupMs: 400 },
};

function classify(cpLoss) {
  if (cpLoss >= THRESHOLDS_CP[SEVERITY.BLUNDER]) return SEVERITY.BLUNDER;
  if (cpLoss >= THRESHOLDS_CP[SEVERITY.MISTAKE]) return SEVERITY.MISTAKE;
  if (cpLoss >= THRESHOLDS_CP[SEVERITY.INACCURACY]) return SEVERITY.INACCURACY;
  return null;
}

function normalizeGameRecord(raw, myUsername) {
  const white = raw.white || {};
  const black = raw.black || {};
  const isWhite = (white.username || '').toLowerCase() === myUsername.toLowerCase();
  const me = isWhite ? white : black;
  const opp = isWhite ? black : white;
  let result = 'draw';
  if (me.result === 'win') result = 'win';
  else if (opp.result === 'win') result = 'loss';
  else if (me.result && me.result !== 'win') result = 'loss_or_draw';
  return {
    id: raw.uuid || raw.url,
    url: raw.url,
    pgn: raw.pgn,
    rules: raw.rules,
    timeClass: raw.time_class,
    rated: raw.rated,
    endTime: raw.end_time,
    myColor: isWhite ? 'w' : 'b',
    myUsername: me.username,
    myRating: me.rating,
    opponentUsername: opp.username,
    opponentRating: opp.rating,
    result,
    resultRaw: me.result,
  };
}

// Extracts the FEN before each of "my" moves, replaying the PGN with chess.js.
function extractMyCandidateMoves(pgn, myColor) {
  const parser = new Chess();
  const ok = parser.load_pgn(pgn, { sloppy: true });
  if (!ok) return [];
  const sanMoves = parser.history();

  const replay = new Chess();
  const candidates = [];
  for (let i = 0; i < sanMoves.length; i++) {
    const sideToMove = replay.turn();
    const fenBefore = replay.fen();
    const moveObj = replay.move(sanMoves[i], { sloppy: true });
    if (!moveObj) break;
    if (sideToMove === myColor) {
      candidates.push({
        ply: i,
        moveNumber: Math.floor(i / 2) + 1,
        fenBefore,
        fenAfter: replay.fen(),
        sanPlayed: moveObj.san,
      });
    }
  }
  return candidates;
}

// Analyzes one game and returns an array of puzzle records (not yet persisted).
async function analyzeGame(gameMeta, speed, onMoveProgress, cancelToken) {
  if (gameMeta.rules !== 'chess') return [];
  const preset = SPEED_PRESETS[speed] || SPEED_PRESETS.balanced;
  const candidates = extractMyCandidateMoves(gameMeta.pgn, gameMeta.myColor);
  const puzzles = [];

  for (let i = 0; i < candidates.length; i++) {
    if (cancelToken && cancelToken.cancelled) break;
    const c = candidates[i];
    if (onMoveProgress) onMoveProgress(i, candidates.length);

    const before = await engine.analyze(c.fenBefore, { movetimeMs: preset.movetimeMs });
    if (!before.bestMoveUci) continue;
    const bestEval = before.scoreCp;

    if (Math.abs(bestEval) > DECIDED_POSITION_CP) continue;

    const bestSan = stripCheckMarks(uciToSanAt(c.fenBefore, before.bestMoveUci) || '');
    const playedSan = stripCheckMarks(c.sanPlayed);

    let cpLoss = 0;
    if (bestSan && bestSan !== playedSan) {
      const after = await engine.analyze(c.fenAfter, { movetimeMs: preset.followupMs });
      const myEvalAfterPlayed = -after.scoreCp;
      cpLoss = Math.max(0, bestEval - myEvalAfterPlayed);
    }

    const severity = classify(cpLoss);
    if (!severity) continue;

    const { sanList, uciTrimmed } = replayUciLine(c.fenBefore, before.pvUci, MAX_SOLUTION_PLIES);
    if (sanList.length === 0) continue;

    puzzles.push({
      id: (crypto.randomUUID ? crypto.randomUUID() : `${gameMeta.id}-${c.ply}-${Date.now()}`),
      gameId: gameMeta.id,
      fen: c.fenBefore,
      sideToMove: gameMeta.myColor,
      moveNumber: c.moveNumber,
      playedSan: c.sanPlayed,
      bestSan,
      solutionSan: sanList,
      solutionUci: uciTrimmed,
      severity,
      cpLoss: Math.round(cpLoss),
      evalBefore: bestEval,
      createdAt: Date.now(),
      opponentUsername: gameMeta.opponentUsername,
      timeClass: gameMeta.timeClass,
      endTime: gameMeta.endTime,
      gameUrl: gameMeta.url,
      labels: [],
      bookmarked: false,
      branches: [],
    });
  }
  return puzzles;
}
