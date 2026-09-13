// Main UI controller wiring the data layer, engine, and views together.

const DEFAULT_LABELS = [
  'hanging piece', 'missed fork', 'allowed fork', 'missed pin', 'allowed pin',
  'back rank', 'missed mate', 'overlooked check', 'queen trap', 'bad trade',
  'time pressure', 'missed tactic', 'weak king safety', 'opening blunder', 'endgame slip',
];

const SEVERITY_LABEL = { blunder: 'Blunder', mistake: 'Mistake', inaccuracy: 'Inaccuracy' };

let allPuzzles = [];
let allPractice = {}; // puzzleId -> record

const libraryFilters = {
  severities: new Set(['blunder', 'mistake', 'inaccuracy']),
  bookmarkedOnly: false,
  labels: new Set(),
  status: 'all',
  sort: 'newest',
};
let libraryShown = 40;
const LIBRARY_PAGE = 40;

let solveSession = { queue: [], index: -1 };
let solveState = null; // { puzzle, board, solverIdx, gaveUp, everWrong }

function el(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(message, kind) {
  const t = el('toast');
  t.textContent = message;
  t.className = 'toast' + (kind === 'error' ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function practiceStatus(puzzleId) {
  const rec = allPractice[puzzleId];
  if (!rec) return 'unsolved';
  return rec.bestStatus || 'unsolved';
}

function severityRank(sev) { return sev === 'blunder' ? 3 : sev === 'mistake' ? 2 : 1; }

// ---------- Navigation ----------
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  el('navSelect').value = name;
  el('view-' + name).classList.add('active');
  if (name === 'library') renderLibrary();
  if (name === 'stats') renderStats();
}

function wireNav() {
  el('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) showView(btn.dataset.view);
  });
  el('navSelect').addEventListener('change', (e) => showView(e.target.value));
  el('goToLibraryFromSolve').addEventListener('click', () => showView('library'));
}

// ---------- Data refresh ----------
async function refreshData() {
  allPuzzles = await DB.puzzles.getAll();
  const rows = await DB.practice.getAll();
  allPractice = {};
  rows.forEach((r) => { allPractice[r.puzzleId] = r; });
  refreshKnownLabels();
}

function refreshKnownLabels() {
  const set = new Set(DEFAULT_LABELS);
  allPuzzles.forEach((p) => (p.labels || []).forEach((l) => set.add(l)));
  const datalist = el('knownLabels');
  datalist.innerHTML = [...set].sort().map((l) => `<option value="${escapeHtml(l)}"></option>`).join('');
  return [...set].sort();
}

// ================= IMPORT =================
function logImport(msg) {
  const li = document.createElement('li');
  li.textContent = msg;
  el('importLog').appendChild(li);
  el('importLog').scrollTop = el('importLog').scrollHeight;
}

function setImportProgress(fraction, label) {
  el('importProgressFill').style.width = Math.round(fraction * 100) + '%';
  if (label) el('importProgressLabel').textContent = label;
}

function wireImport() {
  el('btnImport').addEventListener('click', runImport);
  DB.getSetting('username', '').then((u) => { if (u) el('username').value = u; });
  DB.getSetting('speedPreset', 'balanced').then((s) => { el('speedPreset').value = s; });
}

let importCancelToken = null;
// Shared between the manual "Import & analyze" button and the silent
// auto-check, so the two can never both fetch+analyze the same game at once
// (which could otherwise create duplicate puzzles for it).
let importBusy = false;

async function runImport() {
  if (importBusy) { toast('Already checking chess.com — try again in a moment.', 'error'); return; }
  const username = el('username').value.trim();
  if (!username) { toast('Enter a Chess.com username first.', 'error'); return; }
  const scopeValue = el('monthsBack').value;
  const scope = scopeValue === 'day' ? { unit: 'days', amount: 1 }
    : scopeValue === 'week' ? { unit: 'days', amount: 7 }
    : { unit: 'months', amount: parseInt(scopeValue, 10) };
  const speed = el('speedPreset').value;

  await DB.setSetting('username', username);
  await DB.setSetting('speedPreset', speed);

  importBusy = true;
  el('btnImport').disabled = true;
  el('btnCancelImport').hidden = false;
  el('importProgressPanel').hidden = false;
  el('importLog').innerHTML = '';
  setImportProgress(0, 'Fetching game archives…');
  el('moveProgressLine').textContent = '';

  importCancelToken = { cancelled: false };
  el('btnCancelImport').onclick = () => { importCancelToken.cancelled = true; logImport('Cancelling after current game…'); };

  try {
    const rawGames = await ChessApi.importRecentGames(username, scope, (i, total, label) => {
      setImportProgress(total ? i / total : 0, label);
    });
    logImport(`Fetched ${rawGames.length} game(s) from chess.com.`);

    const existingGames = await DB.games.getAll();
    const existingIds = new Set(existingGames.map((g) => g.id));
    const normalized = rawGames
      .map((g) => normalizeGameRecord(g, username))
      .filter((g) => g.id && !existingIds.has(g.id) && g.rules === 'chess');

    logImport(`${normalized.length} new standard-chess game(s) to analyze.`);
    if (normalized.length === 0) {
      setImportProgress(1, 'Nothing new to analyze.');
      toast('No new games found.');
      return;
    }

    logImport('Starting engine…');
    await engine.init();
    logImport('Engine ready. Analyzing…');

    let totalNewPuzzles = 0;
    const sevCounts = { blunder: 0, mistake: 0, inaccuracy: 0 };

    for (let i = 0; i < normalized.length; i++) {
      if (importCancelToken.cancelled) { logImport('Import cancelled.'); break; }
      const g = normalized[i];
      setImportProgress(i / normalized.length, `Analyzing game ${i + 1}/${normalized.length} vs ${g.opponentUsername}…`);
      await DB.games.put(g);
      const puzzles = await analyzeGame(g, speed, (mi, mtotal) => {
        el('moveProgressLine').textContent = mtotal ? `Move ${mi + 1} of ${mtotal} in this game` : '';
      }, importCancelToken);
      if (puzzles.length) {
        await DB.puzzles.putMany(puzzles);
        puzzles.forEach((p) => sevCounts[p.severity]++);
        totalNewPuzzles += puzzles.length;
        logImport(`vs ${g.opponentUsername} (${g.timeClass}): ${puzzles.length} puzzle(s) found.`);
      }
    }

    setImportProgress(1, importCancelToken.cancelled ? 'Import cancelled.' : 'Import complete.');
    el('moveProgressLine').textContent = '';
    logImport(`Done — ${totalNewPuzzles} new puzzle(s): ${sevCounts.blunder} blunders, ${sevCounts.mistake} mistakes, ${sevCounts.inaccuracy} inaccuracies.`);
    toast(`Import complete: ${totalNewPuzzles} new puzzles.`);

    await refreshData();
  } catch (err) {
    console.error(err);
    logImport('Error: ' + err.message);
    toast(err.message, 'error');
  } finally {
    importBusy = false;
    el('btnImport').disabled = false;
    el('btnCancelImport').hidden = true;
  }
}

// Silently checks Chess.com for games played since the last check and
// analyzes anything new — no button click needed. Safe to call on every app
// load: games already in DB.games are always skipped (chess.com's game UUID
// is the dedup key), and `importBusy` prevents this from ever double-analyzing
// a game that a concurrent manual import is also processing.
const AUTO_CHECK_MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
// Caps how many new games one silent pass will analyze, so opening the app
// after a long gap (or for a very active account) can't turn into a
// multi-minute background job. Leftover games are simply still "new" next
// time — nothing is skipped, just spread across more auto-checks.
const AUTO_CHECK_MAX_GAMES_PER_RUN = 5;

async function maybeAutoCheckForNewGames() {
  const username = await DB.getSetting('username', '');
  if (!username) return; // first-time user — nothing to check yet

  const lastCheck = await DB.getSetting('lastAutoCheckAt', 0);
  if (Date.now() - lastCheck < AUTO_CHECK_MIN_INTERVAL_MS) return;
  if (importBusy) return; // a manual import is already running; try again next time
  importBusy = true;
  await DB.setSetting('lastAutoCheckAt', Date.now());

  try {
    const rawGames = await ChessApi.importRecentGames(username, { unit: 'months', amount: 1 }, () => {});

    const existingGames = await DB.games.getAll();
    const existingIds = new Set(existingGames.map((g) => g.id));
    const allNew = rawGames
      .map((g) => normalizeGameRecord(g, username))
      .filter((g) => g.id && !existingIds.has(g.id) && g.rules === 'chess');
    if (allNew.length === 0) return; // nothing new — stay quiet

    // Analyze the most recent ones first; anything past the cap stays
    // "new" (not yet in DB.games) and will be picked up on a later check.
    allNew.sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
    const toAnalyze = allNew.slice(0, AUTO_CHECK_MAX_GAMES_PER_RUN);
    const remaining = allNew.length - toAnalyze.length;

    let totalNewPuzzles = 0;
    for (const g of toAnalyze) {
      await DB.games.put(g);
      const puzzles = await analyzeGame(g, 'fast', () => {});
      if (puzzles.length) {
        await DB.puzzles.putMany(puzzles);
        totalNewPuzzles += puzzles.length;
      }
    }

    await refreshData();
    if (el('view-library').classList.contains('active')) renderLibrary();
    if (el('view-stats').classList.contains('active')) renderStats();

    const moreNote = remaining > 0 ? ` (${remaining} more queued for next check)` : '';
    if (totalNewPuzzles > 0) {
      toast(`Found ${toAnalyze.length} new game(s) — ${totalNewPuzzles} new puzzle(s) added${moreNote}.`);
    } else {
      toast(`Checked ${toAnalyze.length} new game(s) — no new mistakes found${moreNote}.`);
    }
  } catch (err) {
    console.error('Auto-check failed:', err); // silent — this is a background operation
  } finally {
    importBusy = false;
  }
}

// ================= LIBRARY =================
function wireLibrary() {
  el('severityFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-sev');
    if (!btn) return;
    const sev = btn.dataset.sev;
    if (libraryFilters.severities.has(sev)) libraryFilters.severities.delete(sev);
    else libraryFilters.severities.add(sev);
    btn.classList.toggle('active');
    libraryShown = LIBRARY_PAGE;
    renderLibrary();
  });
  el('bookmarkedOnly').addEventListener('click', (e) => {
    libraryFilters.bookmarkedOnly = !libraryFilters.bookmarkedOnly;
    e.target.classList.toggle('active', libraryFilters.bookmarkedOnly);
    renderLibrary();
  });
  el('statusFilter').addEventListener('change', (e) => { libraryFilters.status = e.target.value; libraryShown = LIBRARY_PAGE; renderLibrary(); });
  el('sortBy').addEventListener('change', (e) => { libraryFilters.sort = e.target.value; renderLibrary(); });
  el('btnLoadMore').addEventListener('click', () => { libraryShown += LIBRARY_PAGE; renderLibrary(); });
  el('btnClearAllPuzzles').addEventListener('click', async () => {
    if (allPuzzles.length === 0) { toast('No puzzles to delete.'); return; }
    if (!confirm(`Delete all ${allPuzzles.length} puzzle(s) and their practice history? This also clears imported game records, so re-importing will re-analyze from scratch. This cannot be undone.`)) return;
    await DB.games.clear();
    await DB.puzzles.clear();
    await DB.practice.clear();
    await refreshData();
    renderLibrary();
    toast('All puzzles deleted.');
  });
}

function renderLabelFilterChips() {
  const labels = refreshKnownLabels().filter((l) => allPuzzles.some((p) => (p.labels || []).includes(l)));
  const container = el('labelFilterChips');
  container.innerHTML = labels.map((l) => `<button class="chip chip-label ${libraryFilters.labels.has(l) ? 'active' : ''}" data-label="${escapeHtml(l)}">${escapeHtml(l)}</button>`).join('');
  container.querySelectorAll('.chip-label').forEach((btn) => {
    btn.addEventListener('click', () => {
      const l = btn.dataset.label;
      if (libraryFilters.labels.has(l)) libraryFilters.labels.delete(l); else libraryFilters.labels.add(l);
      btn.classList.toggle('active');
      renderLibrary();
    });
  });
}

function getFilteredPuzzles() {
  let list = allPuzzles.filter((p) => libraryFilters.severities.has(p.severity));
  if (libraryFilters.bookmarkedOnly) list = list.filter((p) => p.bookmarked);
  if (libraryFilters.labels.size) list = list.filter((p) => (p.labels || []).some((l) => libraryFilters.labels.has(l)));
  if (libraryFilters.status !== 'all') list = list.filter((p) => practiceStatus(p.id) === libraryFilters.status);

  if (libraryFilters.sort === 'newest') list.sort((a, b) => b.createdAt - a.createdAt);
  else if (libraryFilters.sort === 'oldest') list.sort((a, b) => a.createdAt - b.createdAt);
  else if (libraryFilters.sort === 'severity') list.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.cpLoss - a.cpLoss);
  return list;
}

function renderLibrary() {
  renderLabelFilterChips();
  const list = getFilteredPuzzles();
  const grid = el('puzzleGrid');
  el('libraryEmpty').hidden = list.length !== 0;
  grid.innerHTML = '';

  const shown = list.slice(0, libraryShown);
  shown.forEach((p) => grid.appendChild(buildPuzzleCard(p)));
  el('btnLoadMore').hidden = list.length <= libraryShown;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * (ts < 2e10 ? 1000 : 1));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildPuzzleCard(p) {
  const card = document.createElement('div');
  card.className = 'puzzle-card';

  const boardMount = document.createElement('div');
  boardMount.className = 'board-mount board-mini';
  card.appendChild(boardMount);
  const miniBoard = new Board(boardMount, { interactive: false });
  miniBoard.setPosition(p.fen, p.sideToMove);

  const status = practiceStatus(p.id);
  const body = document.createElement('div');
  body.className = 'puzzle-card-body';
  body.innerHTML = `
    <div class="card-top-row">
      <span class="chip chip-sev ${p.severity} active">${SEVERITY_LABEL[p.severity]}</span>
      <button class="star-btn ${p.bookmarked ? 'active' : ''}" data-action="bookmark" title="Bookmark">${p.bookmarked ? '★' : '☆'}</button>
    </div>
    <div class="card-meta"><span class="card-status-dot ${status}"></span>vs ${escapeHtml(p.opponentUsername || '?')} · ${formatDate(p.endTime)} · −${p.cpLoss}cp</div>
    <div class="card-labels">${(p.labels || []).map((l) => `<span class="chip chip-label active" style="cursor:default">${escapeHtml(l)}</span>`).join('')}</div>
    <div class="card-actions">
      <button class="btn btn-primary small" data-action="solve">Solve</button>
      <button class="icon-btn" data-action="delete" title="Delete puzzle">🗑</button>
    </div>
  `;
  card.appendChild(body);

  body.querySelector('[data-action="bookmark"]').addEventListener('click', async () => {
    p.bookmarked = !p.bookmarked;
    await DB.puzzles.put(p);
    renderLibrary();
  });
  body.querySelector('[data-action="solve"]').addEventListener('click', () => {
    solveSession = { queue: [p.id], index: 0 };
    showView('solve');
    loadPuzzleIntoSolver(p.id);
  });
  body.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!confirm('Delete this puzzle? This cannot be undone.')) return;
    await DB.puzzles.delete(p.id);
    await DB.practice.delete(p.id);
    await refreshData();
    renderLibrary();
    toast('Puzzle deleted.');
  });

  return card;
}

// ================= SOLVE =================
function wireSolve() {
  el('btnStartSession').addEventListener('click', () => {
    const list = getFilteredPuzzles();
    if (list.length === 0) { toast('No puzzles match your current filters.', 'error'); return; }
    solveSession = { queue: list.map((p) => p.id), index: 0 };
    loadPuzzleIntoSolver(solveSession.queue[0]);
  });
  el('btnNextPuzzle').addEventListener('click', nextInSession);
  el('btnShowSolution').addEventListener('click', giveUpAndShowSolution);
  el('btnBookmarkSolve').addEventListener('click', async () => {
    if (!solveState) return;
    solveState.puzzle.bookmarked = !solveState.puzzle.bookmarked;
    await DB.puzzles.put(solveState.puzzle);
    renderSolveMeta();
  });
  el('btnDeleteSolve').addEventListener('click', async () => {
    if (!solveState) return;
    if (!confirm('Delete this puzzle? This cannot be undone.')) return;
    const id = solveState.puzzle.id;
    await DB.puzzles.delete(id);
    await DB.practice.delete(id);
    await refreshData();
    toast('Puzzle deleted.');
    nextInSession();
  });
  el('btnAddSolveLabel').addEventListener('click', addLabelToCurrentPuzzle);
  el('solveLabelInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLabelToCurrentPuzzle(); } });
  el('btnSaveBranch').addEventListener('click', () => finalizeBranch(true));
  el('btnDiscardBranch').addEventListener('click', () => finalizeBranch(false));
  el('btnBackToPuzzle').addEventListener('click', exitBranchReview);
}

async function addLabelToCurrentPuzzle() {
  if (!solveState) return;
  const input = el('solveLabelInput');
  const val = input.value.trim();
  if (!val) return;
  if (!solveState.puzzle.labels) solveState.puzzle.labels = [];
  if (!solveState.puzzle.labels.includes(val)) {
    solveState.puzzle.labels.push(val);
    await DB.puzzles.put(solveState.puzzle);
    const idx = allPuzzles.findIndex((p) => p.id === solveState.puzzle.id);
    if (idx >= 0) allPuzzles[idx] = solveState.puzzle;
  }
  input.value = '';
  renderSolveLabels();
}

function nextInSession() {
  if (solveSession.index < 0 || solveSession.index + 1 >= solveSession.queue.length) {
    toast('Session complete.');
    solveSession = { queue: [], index: -1 };
    el('solveContent').hidden = true;
    el('solveEmpty').hidden = false;
    return;
  }
  solveSession.index++;
  loadPuzzleIntoSolver(solveSession.queue[solveSession.index]);
}

function loadPuzzleIntoSolver(puzzleId) {
  const puzzle = allPuzzles.find((p) => p.id === puzzleId);
  if (!puzzle) { toast('Puzzle not found.', 'error'); return; }

  el('solveEmpty').hidden = true;
  el('solveContent').hidden = false;

  const mount = el('solveBoard');
  const board = new Board(mount, { interactive: true, onMove: handleSolverMove, onPositionChange: updateEvalBar });
  board.setPosition(puzzle.fen, puzzle.sideToMove);

  solveState = {
    puzzle, board, solverIdx: 0, gaveUp: false,
    branchMode: false,
    reviewingBranch: null,
    viewingIndex: null,
    history: [{ fen: puzzle.fen, san: null, uci: null }],
  };
  renderSolveMeta();
  renderSolveLabels();
  updateSolveProgress();
  renderMoveNav();
  renderBranches();
  setSolveMode('live');
  el('solveFeedback').textContent = '';
  el('solveFeedback').className = 'solve-feedback';
}

// Toggles which row of controls is visible and updates the prompt/progress
// text for the current mode: 'live' (solving), 'branch' (exploring after a
// wrong move), or 'review' (looking at a previously saved branch).
function setSolveMode(mode) {
  el('liveControls').hidden = mode !== 'live';
  el('branchControls').hidden = mode !== 'branch';
  el('reviewControls').hidden = mode !== 'review';

  if (mode === 'branch') {
    el('solvePrompt').textContent = 'Exploring what happens after that move — not part of the original solution.';
    el('solveProgress').textContent = 'Keep playing against the engine, then save this line to revisit it later.';
  } else if (mode === 'review') {
    const b = solveState.reviewingBranch;
    el('solvePrompt').textContent = 'Reviewing a saved line.';
    el('solveProgress').textContent = b ? `Saved ${new Date(b.createdAt).toLocaleString()} · ${b.history.length - 1} move(s)` : '';
  } else {
    renderSolveMeta();
    updateSolveProgress();
  }
}

// Builds "12. Nf3" / "12… Bg4" style labels from a starting move number/side
// and a list of SAN moves actually played (works equally for the puzzle's
// solution and for any explored branch — the numbering is purely positional
// and doesn't care which specific move was played at each ply).
function buildMoveLabels(startMoveNumber, startSide, sanList) {
  const labels = [];
  let moveNo = startMoveNumber;
  let side = startSide;
  sanList.forEach((san) => {
    labels.push(side === 'w' ? `${moveNo}. ${san}` : `${moveNo}… ${san}`);
    if (side === 'b') moveNo++;
    side = side === 'w' ? 'b' : 'w';
  });
  return labels;
}

function pushHistory(san, uci) {
  solveState.history.push({ fen: solveState.board.chess.fen(), san, uci });
  renderMoveNav();
}

function renderMoveNav() {
  const container = el('solveMoveNav');
  if (!solveState) { container.innerHTML = ''; return; }
  const reviewing = !!solveState.reviewingBranch;
  const h = reviewing ? solveState.reviewingBranch.history : solveState.history;
  const p = solveState.puzzle;
  const labels = buildMoveLabels(p.moveNumber, p.sideToMove, h.slice(1).map((e) => e.san));
  const liveIdx = h.length - 1;
  container.innerHTML = h.map((entry, i) => {
    const label = i === 0 ? 'Start' : labels[i - 1];
    const isActive = solveState.viewingIndex === null ? i === liveIdx : i === solveState.viewingIndex;
    return `<button class="move-nav-chip ${isActive ? 'active' : ''}" data-idx="${i}">${escapeHtml(label)}</button>`;
  }).join('');
  container.querySelectorAll('.move-nav-chip').forEach((btn) => {
    btn.addEventListener('click', () => viewHistoryIndex(parseInt(btn.dataset.idx, 10)));
  });
}

function viewHistoryIndex(idx) {
  if (!solveState) return;
  const reviewing = !!solveState.reviewingBranch;
  const h = reviewing ? solveState.reviewingBranch.history : solveState.history;
  const liveIdx = h.length - 1;

  if (!reviewing && idx === liveIdx) {
    solveState.viewingIndex = null;
    solveState.board.clearPreview();
  } else {
    solveState.viewingIndex = idx;
    const entry = h[idx];
    const arrows = entry.uci ? [{ from: entry.uci.slice(0, 2), to: entry.uci.slice(2, 4), kind: 'last' }] : [];
    solveState.board.showPreview(entry.fen, arrows);
  }
  renderMoveNav();
}

function renderSolveMeta() {
  const p = solveState.puzzle;
  const badge = el('solveSevBadge');
  badge.textContent = SEVERITY_LABEL[p.severity];
  badge.className = `chip chip-sev ${p.severity} active`;
  el('solveOpponent').textContent = `vs ${p.opponentUsername || '?'} · ${formatDate(p.endTime)} · move ${p.moveNumber}`;
  const side = p.sideToMove === 'w' ? 'White' : 'Black';
  el('solvePrompt').textContent = `Find the best continuation for ${side}.`;
  el('btnBookmarkSolve').textContent = p.bookmarked ? '★ Bookmarked' : '☆ Bookmark';
  el('solveGameLink').href = p.gameUrl || '#';
}

function renderSolveLabels() {
  const p = solveState.puzzle;
  const container = el('solveLabelChips');
  container.innerHTML = (p.labels || []).map((l) => `<span class="chip chip-label active">${escapeHtml(l)}<span class="chip-remove" data-label="${escapeHtml(l)}">✕</span></span>`).join('');
  container.querySelectorAll('.chip-remove').forEach((x) => {
    x.addEventListener('click', async () => {
      p.labels = p.labels.filter((l) => l !== x.dataset.label);
      await DB.puzzles.put(p);
      const idx = allPuzzles.findIndex((pp) => pp.id === p.id);
      if (idx >= 0) allPuzzles[idx] = p;
      renderSolveLabels();
    });
  });
}

function updateSolveProgress() {
  const p = solveState.puzzle;
  const total = p.solutionSan.length;
  el('solveProgress').textContent = `Your move ${Math.min(solveState.solverIdx + 1, total)} of ${total} (up to ${total} plies)`;
}

// Converts a centipawn score (White's perspective) to a 0-100 fill
// percentage for the White portion of the eval bar, using a logistic curve
// so extreme evaluations approach but never quite reach the ends.
function evalCpToWhitePercent(cp) {
  const pct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
  return Math.max(3, Math.min(97, pct));
}

let evalBarRequestId = 0;
async function updateEvalBar(fen) {
  const myId = ++evalBarRequestId;
  let sideToMove;
  try { sideToMove = fen.split(' ')[1]; } catch (e) { return; }
  let res;
  try {
    res = await engine.analyze(fen, { movetimeMs: 400 });
  } catch (e) { return; }
  if (myId !== evalBarRequestId) return; // a newer position has since been requested

  const whiteCp = sideToMove === 'w' ? res.scoreCp : -res.scoreCp;
  const whiteMate = res.mate ? (sideToMove === 'w' ? res.mate : -res.mate) : null;

  const pct = evalCpToWhitePercent(whiteMate ? (whiteMate > 0 ? 100000 : -100000) : whiteCp);
  el('evalBarWhite').style.flexBasis = pct + '%';
  el('evalBarBlack').style.flexBasis = (100 - pct) + '%';

  let label;
  if (whiteMate) label = (whiteMate > 0 ? '#' : '−#') + Math.abs(whiteMate);
  else label = (whiteCp >= 0 ? '+' : '') + (whiteCp / 100).toFixed(1);
  el('evalLabel').textContent = label;
}

async function recordPracticeOutcome(puzzleId, outcome) {
  let rec = allPractice[puzzleId];
  if (!rec) rec = { puzzleId, timesAttempted: 0, timesSolved: 0, timesFailed: 0, bestStatus: 'unsolved', history: [] };
  rec.timesAttempted++;
  rec.lastAttemptAt = Date.now();
  if (outcome === 'solved') {
    rec.timesSolved++;
    rec.solvedAt = Date.now();
    rec.bestStatus = 'solved';
  } else {
    rec.timesFailed++;
    if (rec.bestStatus !== 'solved') rec.bestStatus = 'failed';
  }
  rec.history = rec.history || [];
  rec.history.push({ date: Date.now(), outcome });
  if (rec.history.length > 50) rec.history = rec.history.slice(-50);
  await DB.practice.put(rec);
  allPractice[puzzleId] = rec;
}

function handleSolverMove(move) {
  if (!solveState || solveState.gaveUp) return;
  if (solveState.branchMode) { handleBranchMove(move); return; }

  const p = solveState.puzzle;
  const expected = p.solutionUci[solveState.solverIdx];
  const attempted = move.uci.length === 5 && expected && expected.length === 4 ? move.uci.slice(0, 4) : move.uci;

  if (expected && attempted === expected) {
    const sanPlayed = p.solutionSan[solveState.solverIdx];
    solveState.board.applyUci(expected);
    pushHistory(sanPlayed, expected);
    solveState.solverIdx++;
    el('solveFeedback').textContent = 'Correct.';
    el('solveFeedback').className = 'solve-feedback correct';

    if (solveState.solverIdx >= p.solutionSan.length) {
      finishSolved();
      return;
    }
    const oppMove = p.solutionUci[solveState.solverIdx];
    if (oppMove) {
      const oppSan = p.solutionSan[solveState.solverIdx];
      setTimeout(() => {
        if (!solveState) return;
        solveState.board.applyUci(oppMove);
        pushHistory(oppSan, oppMove);
        solveState.solverIdx++;
        updateSolveProgress();
        if (solveState.solverIdx >= p.solutionSan.length) finishSolved();
      }, 450);
    }
    updateSolveProgress();
  } else {
    startBranch(move.uci);
  }
}

// A wrong move no longer gets an engine explanation — it just gets flagged,
// committed to the board for real, and the engine replies so the user can
// keep playing and see for themselves what goes wrong. The whole excursion
// (from the puzzle start through wherever they stop) can be saved for later.
function startBranch(uci) {
  const applied = solveState.board.applyUci(uci);
  if (!applied) return;
  pushHistory(applied.san, uci);
  solveState.branchMode = true;
  recordPracticeOutcome(solveState.puzzle.id, 'failed');
  el('solveFeedback').textContent = 'Not the best move.';
  el('solveFeedback').className = 'solve-feedback wrong';
  setSolveMode('branch');
  scheduleEngineReplyInBranch();
}

function handleBranchMove(move) {
  const applied = solveState.board.applyUci(move.uci);
  if (!applied) return;
  pushHistory(applied.san, move.uci);
  scheduleEngineReplyInBranch();
}

function scheduleEngineReplyInBranch() {
  const puzzleId = solveState.puzzle.id;
  setTimeout(async () => {
    if (!solveState || !solveState.branchMode || solveState.puzzle.id !== puzzleId) return;
    if (solveState.board.chess.game_over()) return;
    const fen = solveState.board.chess.fen();
    let res;
    try {
      res = await engine.analyze(fen, { movetimeMs: 500 });
    } catch (e) { return; }
    if (!solveState || !solveState.branchMode || solveState.puzzle.id !== puzzleId) return;
    if (res.bestMoveUci) {
      const applied = solveState.board.applyUci(res.bestMoveUci);
      if (applied) pushHistory(applied.san, res.bestMoveUci);
    }
  }, 450);
}

// Ends the current exploration. If `save` is true (and at least one move was
// played), the full line is stored on the puzzle for later review.
async function finalizeBranch(save) {
  if (!solveState || !solveState.branchMode) return;
  const puzzle = solveState.puzzle;
  if (save && solveState.history.length > 1) {
    const branch = {
      id: crypto.randomUUID ? crypto.randomUUID() : `branch-${Date.now()}`,
      history: solveState.history.map((h) => ({ fen: h.fen, san: h.san, uci: h.uci })),
      createdAt: Date.now(),
    };
    puzzle.branches = puzzle.branches || [];
    puzzle.branches.push(branch);
    await DB.puzzles.put(puzzle);
    const idx = allPuzzles.findIndex((pp) => pp.id === puzzle.id);
    if (idx >= 0) allPuzzles[idx] = puzzle;
    toast('Line saved — see "Explored lines" below to revisit it.');
  }
  loadPuzzleIntoSolver(puzzle.id);
}

function finishSolved() {
  el('solveFeedback').textContent = 'Puzzle solved!';
  el('solveFeedback').className = 'solve-feedback solved';
  recordPracticeOutcome(solveState.puzzle.id, 'solved');
}

function renderBranches() {
  const container = el('branchList');
  const branches = (solveState.puzzle.branches || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  if (!branches.length) {
    container.innerHTML = '<p class="muted">No explored lines saved yet — they appear here after you play out a mistake.</p>';
    return;
  }
  container.innerHTML = branches.map((b) => {
    const plies = b.history.length - 1;
    const preview = b.history.slice(1, 5).map((h) => h.san).join(' ') + (plies > 4 ? ' …' : '');
    return `
      <div class="branch-row" data-id="${b.id}">
        <button class="branch-view-btn" data-action="view" data-id="${b.id}">
          ${new Date(b.createdAt).toLocaleString()} · ${plies} move(s)
          <span class="branch-line">${escapeHtml(preview)}</span>
        </button>
        <button class="icon-btn" data-action="delete" data-id="${b.id}" title="Delete this line">🗑</button>
      </div>`;
  }).join('');

  container.querySelectorAll('[data-action="view"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const branch = branches.find((b) => b.id === btn.dataset.id);
      if (branch) reviewBranch(branch);
    });
  });
  container.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this saved line? This cannot be undone.')) return;
      const puzzle = solveState.puzzle;
      puzzle.branches = (puzzle.branches || []).filter((b) => b.id !== btn.dataset.id);
      await DB.puzzles.put(puzzle);
      const idx = allPuzzles.findIndex((pp) => pp.id === puzzle.id);
      if (idx >= 0) allPuzzles[idx] = puzzle;
      renderBranches();
      if (solveState.reviewingBranch && solveState.reviewingBranch.id === btn.dataset.id) {
        exitBranchReview();
      }
    });
  });
}

function reviewBranch(branch) {
  solveState.reviewingBranch = branch;
  solveState.viewingIndex = branch.history.length - 1;
  const last = branch.history[branch.history.length - 1];
  const arrows = last.uci ? [{ from: last.uci.slice(0, 2), to: last.uci.slice(2, 4), kind: 'last' }] : [];
  solveState.board.showPreview(last.fen, arrows);
  setSolveMode('review');
  renderMoveNav();
  el('solveFeedback').textContent = '';
  el('solveFeedback').className = 'solve-feedback';
}

function exitBranchReview() {
  if (!solveState) return;
  loadPuzzleIntoSolver(solveState.puzzle.id);
}

function giveUpAndShowSolution() {
  if (!solveState || solveState.gaveUp || solveState.branchMode) return;
  solveState.gaveUp = true;
  solveState.viewingIndex = null;
  solveState.board.clearPreview();
  const p = solveState.puzzle;
  const remaining = p.solutionUci.slice(solveState.solverIdx);
  const remainingSan = p.solutionSan.slice(solveState.solverIdx);
  let i = 0;
  const step = () => {
    if (i >= remaining.length) return;
    solveState.board.applyUci(remaining[i]);
    pushHistory(remainingSan[i], remaining[i]);
    solveState.solverIdx++;
    updateSolveProgress();
    i++;
    setTimeout(step, 500);
  };
  step();
  el('solveFeedback').textContent = `Solution: ${p.solutionSan.join(' ')}`;
  el('solveFeedback').className = 'solve-feedback wrong';
  recordPracticeOutcome(p.id, 'failed');
}

// ================= STATS =================
function renderStats() {
  const total = allPuzzles.length;
  const solved = allPuzzles.filter((p) => practiceStatus(p.id) === 'solved').length;
  const failed = allPuzzles.filter((p) => practiceStatus(p.id) === 'failed').length;
  const unattempted = total - solved - failed;

  el('statsSummary').innerHTML = [
    ['Total puzzles', total],
    ['Solved', solved],
    ['Attempted, unsolved', failed],
    ['Untouched', unattempted],
  ].map(([label, num]) => `<div class="stat-card"><span class="stat-num">${num}</span><span class="stat-label">${label}</span></div>`).join('');

  const sevBlock = ['blunder', 'mistake', 'inaccuracy'].map((sev) => {
    const items = allPuzzles.filter((p) => p.severity === sev);
    const solvedCount = items.filter((p) => practiceStatus(p.id) === 'solved').length;
    const pct = items.length ? Math.round((solvedCount / items.length) * 100) : 0;
    const color = `var(--${sev})`;
    return `<div class="bar-row"><span class="bar-label">${SEVERITY_LABEL[sev]}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div><span class="bar-count">${solvedCount}/${items.length}</span></div>`;
  }).join('');
  el('statsBySeverity').innerHTML = sevBlock || '<p class="muted">No puzzles yet.</p>';

  const labelCounts = {};
  allPuzzles.forEach((p) => (p.labels || []).forEach((l) => { labelCounts[l] = (labelCounts[l] || 0) + 1; }));
  const labelEntries = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  el('statsByLabel').innerHTML = labelEntries.length
    ? labelEntries.map(([l, c]) => `<div class="bar-row"><span class="bar-label">${escapeHtml(l)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((c / labelEntries[0][1]) * 100)}%;background:var(--accent)"></div></div><span class="bar-count">${c}</span></div>`).join('')
    : '<p class="muted">No labels added yet.</p>';

  const recent = Object.values(allPractice).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt).slice(0, 20);
  const statsRecentEl = el('statsRecent');
  statsRecentEl.innerHTML = recent.length ? recent.map((r) => {
    const p = allPuzzles.find((pp) => pp.id === r.puzzleId);
    if (!p) return '';
    const last = r.history && r.history.length ? r.history[r.history.length - 1].outcome : r.bestStatus;
    return `<li class="clickable" data-puzzle-id="${p.id}"><span>${SEVERITY_LABEL[p.severity]} vs ${escapeHtml(p.opponentUsername || '?')}</span><span>${last === 'solved' ? '✓ solved' : '✗ not solved'} · ${new Date(r.lastAttemptAt).toLocaleDateString()}</span></li>`;
  }).join('') : '<li class="muted">No practice activity yet.</li>';

  statsRecentEl.querySelectorAll('li.clickable').forEach((li) => {
    li.addEventListener('click', () => {
      const id = li.dataset.puzzleId;
      solveSession = { queue: [id], index: 0 };
      showView('solve');
      loadPuzzleIntoSolver(id);
    });
  });
}

// ================= INIT =================
async function init() {
  await DB.init();
  await refreshData();
  wireNav();
  wireImport();
  wireLibrary();
  wireSolve();
  showView(allPuzzles.length ? 'library' : 'import');
  maybeAutoCheckForNewGames(); // fire-and-forget: runs quietly in the background
}

init();
