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

// A puzzle counts as solved once the player has correctly played this many
// of their own moves, even if the stored solution line is longer — anything
// after that point is optional exploration, not required for credit.
const PLAYER_MOVES_TO_SOLVE = 3;

let sessionOrder = 'newest'; // order for a Practice-tab session: newest/oldest/random/mostWrong

let solveSession = { queue: [], index: -1 };
let solveState = null; // { puzzle, board, solverIdx, gaveUp, branchMode, alreadySolved, ... }

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
  if (name === 'solve') { syncFilterControls(); updateSessionCount(); }
  if (name === 'aicoach') el('apiKeyInput').value = getApiKey();
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
  el('btnCreateManualPuzzle').addEventListener('click', createManualPuzzle);
}

// Builds a puzzle directly from a pasted FEN — no game/import involved. The
// engine works out the solution line right away, same as it would for an
// imported mistake; there's just no "actual game move" or opponent to record,
// so those fields stay empty and the puzzle is flagged `manual` so the UI
// can show a sensible label instead of "vs ?".
async function createManualPuzzle() {
  const fenInput = el('manualFen');
  const statusEl = el('manualPuzzleStatus');
  const btn = el('btnCreateManualPuzzle');
  const fen = fenInput.value.trim();
  if (!fen) { toast('Paste a FEN first.', 'error'); return; }

  const check = new Chess().validate_fen(fen);
  if (!check.valid) {
    statusEl.textContent = `Invalid FEN: ${check.error}`;
    return;
  }

  const severity = el('manualSeverity').value;
  const title = el('manualTitle').value.trim();

  btn.disabled = true;
  statusEl.textContent = 'Analyzing position…';

  try {
    await engine.init();
    const analysis = await engine.analyze(fen, { movetimeMs: 500 });
    if (!analysis.bestMoveUci) {
      statusEl.textContent = 'This position has no legal moves (checkmate or stalemate) — nothing to solve.';
      return;
    }

    const bestSan = stripCheckMarks(uciToSanAt(fen, analysis.bestMoveUci) || '');
    const { sanList, uciTrimmed } = replayUciLine(fen, analysis.pvUci || [], MAX_SOLUTION_PLIES);
    if (sanList.length === 0) {
      statusEl.textContent = "Couldn't work out a solution line from this position.";
      return;
    }

    const fenParts = fen.split(' ');
    const sideToMove = fenParts[1];
    const moveNumber = parseInt(fenParts[5], 10) || 1;

    const puzzle = {
      id: crypto.randomUUID ? crypto.randomUUID() : `manual-${Date.now()}`,
      gameId: null,
      fen,
      sideToMove,
      moveNumber,
      playedSan: null,
      bestSan,
      solutionSan: sanList,
      solutionUci: uciTrimmed,
      severity,
      cpLoss: 0,
      evalBefore: analysis.scoreCp,
      createdAt: Date.now(),
      opponentUsername: null,
      timeClass: null,
      endTime: Math.floor(Date.now() / 1000),
      gameUrl: null,
      labels: [],
      bookmarked: false,
      branches: [],
      manual: true,
      title: title || null,
    };

    await DB.puzzles.put(puzzle);
    await refreshData();
    toast('Puzzle created.');
    statusEl.innerHTML = 'Puzzle created! <button type="button" class="link-btn" id="btnSolveManualNow">Solve it now</button> or find it later in the Puzzles library.';
    const solveNowBtn = el('btnSolveManualNow');
    if (solveNowBtn) {
      solveNowBtn.addEventListener('click', () => {
        solveSession = { queue: [puzzle.id], index: 0 };
        showView('solve');
        loadPuzzleIntoSolver(puzzle.id);
      });
    }
    fenInput.value = '';
    el('manualTitle').value = '';
  } catch (e) {
    statusEl.textContent = `Couldn't create the puzzle: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
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
// Severity/bookmark/status/label filters are shared (via `libraryFilters`)
// between the Puzzle library and the Practice tab's session setup panel, so
// each has its own set of controls but they always stay in sync.
function wireLibrary() {
  el('severityFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-sev');
    if (!btn) return;
    toggleSeverityFilter(btn.dataset.sev);
  });
  el('bookmarkedOnly').addEventListener('click', () => toggleBookmarkedOnlyFilter());
  el('statusFilter').addEventListener('change', (e) => setStatusFilter(e.target.value));
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

function wirePracticeSessionFilters() {
  el('sessionSeverityFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-sev');
    if (!btn) return;
    toggleSeverityFilter(btn.dataset.sev);
  });
  el('sessionBookmarkedOnly').addEventListener('click', () => toggleBookmarkedOnlyFilter());
  el('sessionStatusFilter').addEventListener('change', (e) => setStatusFilter(e.target.value));
  el('sessionOrder').addEventListener('change', (e) => { sessionOrder = e.target.value; updateSessionCount(); });
  el('btnStartSession').addEventListener('click', () => {
    const queue = getPracticeSessionQueue();
    if (queue.length === 0) { toast('No puzzles match your current filters.', 'error'); return; }
    solveSession = { queue, index: 0 };
    loadPuzzleIntoSolver(solveSession.queue[0]);
  });
}

function toggleSeverityFilter(sev) {
  if (libraryFilters.severities.has(sev)) libraryFilters.severities.delete(sev);
  else libraryFilters.severities.add(sev);
  syncFilterControls();
  libraryShown = LIBRARY_PAGE;
  renderLibrary();
  updateSessionCount();
}

function toggleBookmarkedOnlyFilter() {
  libraryFilters.bookmarkedOnly = !libraryFilters.bookmarkedOnly;
  syncFilterControls();
  renderLibrary();
  updateSessionCount();
}

function setStatusFilter(value) {
  libraryFilters.status = value;
  syncFilterControls();
  libraryShown = LIBRARY_PAGE;
  renderLibrary();
  updateSessionCount();
}

// Keeps the library filter bar and the practice-session filter panel showing
// the same state, no matter which one the user last touched.
function syncFilterControls() {
  ['severityFilters', 'sessionSeverityFilters'].forEach((id) => {
    const c = el(id);
    if (c) c.querySelectorAll('.chip-sev').forEach((btn) => btn.classList.toggle('active', libraryFilters.severities.has(btn.dataset.sev)));
  });
  ['bookmarkedOnly', 'sessionBookmarkedOnly'].forEach((id) => {
    const b = el(id);
    if (b) b.classList.toggle('active', libraryFilters.bookmarkedOnly);
  });
  ['statusFilter', 'sessionStatusFilter'].forEach((id) => {
    const s = el(id);
    if (s) s.value = libraryFilters.status;
  });
  renderLabelFilterChipsInto('labelFilterChips');
  renderLabelFilterChipsInto('sessionLabelFilterChips');
}

function renderLabelFilterChipsInto(containerId) {
  const container = el(containerId);
  if (!container) return;
  const labels = refreshKnownLabels().filter((l) => allPuzzles.some((p) => (p.labels || []).includes(l)));
  container.innerHTML = labels.map((l) => `<button class="chip chip-label ${libraryFilters.labels.has(l) ? 'active' : ''}" data-label="${escapeHtml(l)}">${escapeHtml(l)}</button>`).join('');
  container.querySelectorAll('.chip-label').forEach((btn) => {
    btn.addEventListener('click', () => {
      const l = btn.dataset.label;
      if (libraryFilters.labels.has(l)) libraryFilters.labels.delete(l); else libraryFilters.labels.add(l);
      syncFilterControls();
      libraryShown = LIBRARY_PAGE;
      renderLibrary();
      updateSessionCount();
    });
  });
}

function updateSessionCount() {
  const countEl = el('sessionCount');
  if (!countEl) return;
  const n = getFilteredPuzzlesRaw().length;
  countEl.textContent = n === 0 ? 'No puzzles match these filters yet.' : `${n} puzzle${n === 1 ? '' : 's'} match — ready to practice.`;
}

// Filtering only (severity/bookmark/label/status) — shared by the library
// view (which then applies its own display sort) and the practice session
// builder (which applies its own play-order instead).
function getFilteredPuzzlesRaw() {
  let list = allPuzzles.filter((p) => libraryFilters.severities.has(p.severity));
  if (libraryFilters.bookmarkedOnly) list = list.filter((p) => p.bookmarked);
  if (libraryFilters.labels.size) list = list.filter((p) => (p.labels || []).some((l) => libraryFilters.labels.has(l)));
  if (libraryFilters.status !== 'all') list = list.filter((p) => practiceStatus(p.id) === libraryFilters.status);
  return list;
}

function timesWrong(puzzleId) {
  return (allPractice[puzzleId] && allPractice[puzzleId].timesFailed) || 0;
}

function getFilteredPuzzles() {
  const list = getFilteredPuzzlesRaw();
  if (libraryFilters.sort === 'newest') list.sort((a, b) => b.createdAt - a.createdAt);
  else if (libraryFilters.sort === 'oldest') list.sort((a, b) => a.createdAt - b.createdAt);
  else if (libraryFilters.sort === 'severity') list.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.cpLoss - a.cpLoss);
  else if (libraryFilters.sort === 'mostWrong') list.sort((a, b) => timesWrong(b.id) - timesWrong(a.id));
  return list;
}

// Builds the ordered puzzle-id queue for a Practice-tab session, using the
// same filters as the library but the session's own play-order setting.
function getPracticeSessionQueue() {
  const list = getFilteredPuzzlesRaw();
  if (sessionOrder === 'newest') list.sort((a, b) => b.createdAt - a.createdAt);
  else if (sessionOrder === 'oldest') list.sort((a, b) => a.createdAt - b.createdAt);
  else if (sessionOrder === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  } else if (sessionOrder === 'mostWrong') {
    list.sort((a, b) => timesWrong(b.id) - timesWrong(a.id));
  }
  return list.map((p) => p.id);
}

function renderLibrary() {
  syncFilterControls();
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
  const wrongCount = timesWrong(p.id);
  const wrongNote = wrongCount > 0 ? ` · wrong ${wrongCount}×` : '';
  const metaLine = p.manual
    ? `${escapeHtml(p.title || 'Custom position')} · ${formatDate(p.endTime)}${wrongNote}`
    : `vs ${escapeHtml(p.opponentUsername || '?')} · ${formatDate(p.endTime)} · −${p.cpLoss}cp${wrongNote}`;
  const body = document.createElement('div');
  body.className = 'puzzle-card-body';
  body.innerHTML = `
    <div class="card-top-row">
      <span class="chip chip-sev ${p.severity} active">${SEVERITY_LABEL[p.severity]}</span>
      <button class="star-btn ${p.bookmarked ? 'active' : ''}" data-action="bookmark" title="Bookmark">${p.bookmarked ? '★' : '☆'}</button>
    </div>
    <div class="card-meta"><span class="card-status-dot ${status}"></span>${metaLine}</div>
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
  el('btnPrevPuzzle').addEventListener('click', previousInSession);
  el('btnNextPuzzle').addEventListener('click', nextInSession);
  el('btnShowSolution').addEventListener('click', giveUpAndShowSolution);
  el('btnPlayFromHere').addEventListener('click', continueFromViewedPosition);
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
  el('btnAddSolveLabel').addEventListener('click', () => addLabelToCurrentPuzzle());
  el('solveLabelInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLabelToCurrentPuzzle(); } });
  el('btnSaveBranch').addEventListener('click', () => finalizeBranch(true));
  el('btnDiscardBranch').addEventListener('click', () => finalizeBranch(false));
  el('btnShowHint').addEventListener('click', showBranchHint);
  el('btnManualOpponent').addEventListener('click', toggleManualOpponent);
  el('btnBackToPuzzle').addEventListener('click', exitBranchReview);
  el('btnChangePracticeSet').addEventListener('click', changePracticeSet);
}

// Lets the user leave the current session mid-puzzle and pick a new
// filter/order combination from the session-setup panel, without having to
// finish or abandon the puzzle any other way.
function changePracticeSet() {
  const hasUnsavedExploration = solveState && solveState.branchMode && !solveState.reviewingBranch && solveState.history.length > 1;
  if (hasUnsavedExploration) {
    const ok = confirm('Switch practice set? Any exploration moves on this puzzle that you haven\'t saved as a line will be lost.');
    if (!ok) return;
  }
  solveSession = { queue: [], index: -1 };
  solveState = null;
  el('solveContent').hidden = true;
  el('solveEmpty').hidden = false;
  syncFilterControls();
  updateSessionCount();
}

// `quickLabel`, when given, adds that label directly (from a quick-add chip)
// instead of reading the text input.
async function addLabelToCurrentPuzzle(quickLabel) {
  if (!solveState) return;
  const input = el('solveLabelInput');
  const val = (quickLabel !== undefined ? quickLabel : input.value).trim();
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

function previousInSession() {
  if (solveSession.index <= 0) { toast('This is the first puzzle in this session.'); return; }
  solveSession.index--;
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
    branchMode: false, alreadySolved: false, manualOpponent: false,
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
  resetStrategyHint();
  el('solveFeedback').textContent = '';
  el('solveFeedback').className = 'solve-feedback';

  const inSession = solveSession.index >= 0 && solveSession.queue.length > 0;
  el('btnPrevPuzzle').disabled = !inSession || solveSession.index <= 0;
}

// Toggles which row of controls is visible and updates the prompt/progress
// text for the current mode: 'live' (solving), 'branch' (exploring after a
// wrong move), or 'review' (looking at a previously saved branch).
function setSolveMode(mode) {
  el('liveControls').hidden = mode !== 'live';
  el('branchControls').hidden = mode !== 'branch';
  el('branchNotesRow').hidden = mode !== 'branch';
  el('reviewControls').hidden = mode !== 'review';
  // strategyHintControls is intentionally NOT toggled here — the strategy
  // hint stays available in every mode, including after the puzzle is
  // solved or its solution has been revealed.

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
  updateBranchControls();
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
  updateBranchControls();
}

function renderMoveNav() {
  const container = el('solveMoveNav');
  if (!solveState) { container.innerHTML = ''; el('btnPlayFromHere').hidden = true; return; }
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
  // "Play from here" makes sense whenever we're looking at any position that
  // isn't the live end of the current line — whether scrubbing back through
  // this attempt or browsing a saved explored line.
  el('btnPlayFromHere').hidden = solveState.viewingIndex === null;
  updateStrategyHintButton();
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
  updateBranchControls();
}

// Forks a brand-new line starting from whatever position is currently being
// viewed — either an earlier point in this attempt, or any point within a
// saved explored line. From here on it's free play against the engine
// (branch mode), and the result can be saved as its own explored line.
function continueFromViewedPosition() {
  if (!solveState || solveState.viewingIndex === null) return;
  const reviewingSaved = !!solveState.reviewingBranch;
  const h = reviewingSaved ? solveState.reviewingBranch.history : solveState.history;
  const idx = solveState.viewingIndex;
  const entry = h[idx];

  const discardsLiveMoves = !reviewingSaved && idx < h.length - 1;
  if (discardsLiveMoves) {
    const ok = confirm('Continue from here? This starts a new line from this point — the moves after it in the current line will be replaced (save the current line first if you want to keep it).');
    if (!ok) return;
  }

  solveState.reviewingBranch = null;
  solveState.history = h.slice(0, idx + 1).map((e) => ({ fen: e.fen, san: e.san, uci: e.uci }));
  solveState.viewingIndex = null;
  solveState.branchMode = true;
  solveState.manualOpponent = false;
  solveState.alreadySolved = true; // no longer tracking toward the stored solution

  solveState.board.clearPreview();
  solveState.board.setPosition(entry.fen, solveState.puzzle.sideToMove);
  if (entry.uci) {
    solveState.board.lastMove = { from: entry.uci.slice(0, 2), to: entry.uci.slice(2, 4) };
    solveState.board._render();
  }

  setSolveMode('branch');
  renderMoveNav();
  el('solveFeedback').textContent = 'Continuing from here — this is a new line.';
  el('solveFeedback').className = 'solve-feedback wrong';

  if (solveState.board.chess.turn() !== solveState.puzzle.sideToMove) {
    scheduleEngineReplyIfAuto();
  }
}

function renderSolveMeta() {
  const p = solveState.puzzle;
  const badge = el('solveSevBadge');
  badge.textContent = SEVERITY_LABEL[p.severity];
  badge.className = `chip chip-sev ${p.severity} active`;
  el('solveOpponent').textContent = p.manual
    ? `${p.title || 'Custom position'} · ${formatDate(p.endTime)} · move ${p.moveNumber}`
    : `vs ${p.opponentUsername || '?'} · ${formatDate(p.endTime)} · move ${p.moveNumber}`;
  const side = p.sideToMove === 'w' ? 'White' : 'Black';
  el('solvePrompt').textContent = `Find the best continuation for ${side}.`;
  el('btnBookmarkSolve').textContent = p.bookmarked ? '★ Bookmarked' : '☆ Bookmark';
  el('gameLinkRow').hidden = !p.gameUrl;
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
  renderSolveLabelSuggestions();
}

// One-click "quick add" chips for every known label not already on this
// puzzle — the datalist on the text input doesn't show suggestions at all on
// iOS Safari, so this is the only usable quick-pick on a phone.
function renderSolveLabelSuggestions() {
  const p = solveState.puzzle;
  const container = el('solveLabelQuickAdd');
  const applied = new Set(p.labels || []);
  const suggestions = refreshKnownLabels().filter((l) => !applied.has(l));
  if (!suggestions.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = suggestions.map((l) => `<button type="button" class="chip chip-label" data-label="${escapeHtml(l)}">+ ${escapeHtml(l)}</button>`).join('');
  container.querySelectorAll('.chip-label').forEach((btn) => {
    btn.addEventListener('click', () => addLabelToCurrentPuzzle(btn.dataset.label));
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
  if (!solveState) return;
  if (solveState.branchMode) { handleBranchMove(move); return; }
  if (solveState.gaveUp) return; // mid-reveal animation; branchMode kicks in once it finishes

  const p = solveState.puzzle;
  const expected = p.solutionUci[solveState.solverIdx];
  const attempted = move.uci.length === 5 && expected && expected.length === 4 ? move.uci.slice(0, 4) : move.uci;

  if (expected && attempted === expected) {
    const sanPlayed = p.solutionSan[solveState.solverIdx];
    solveState.board.applyUci(expected);
    pushHistory(sanPlayed, expected);
    solveState.solverIdx++;

    if (checkSolveThreshold()) {
      // Solved as soon as the threshold is crossed — don't also play out any
      // remaining scripted opponent reply; from here it's free exploration.
      enterExploreMode(solvedMessage(), 'solved', true);
      return;
    }

    el('solveFeedback').textContent = 'Correct.';
    el('solveFeedback').className = 'solve-feedback correct';

    const oppMove = p.solutionUci[solveState.solverIdx];
    if (oppMove) {
      const oppSan = p.solutionSan[solveState.solverIdx];
      setTimeout(() => {
        if (!solveState) return;
        solveState.board.applyUci(oppMove);
        pushHistory(oppSan, oppMove);
        solveState.solverIdx++;
        updateSolveProgress();
        if (checkSolveThreshold()) enterExploreMode(solvedMessage(), 'solved', false);
      }, 450);
    }
    updateSolveProgress();
  } else {
    startBranch(move.uci);
  }
}

function solvedMessage() {
  return 'Puzzle solved! Anything you play from here is optional exploration.';
}

// True once the player has correctly played PLAYER_MOVES_TO_SOLVE of their
// own moves, or the stored solution line has been fully played out —
// whichever comes first (a short 2-ply puzzle can't wait for 3 player
// moves that don't exist). Records the "solved" outcome exactly once.
function checkSolveThreshold() {
  if (solveState.alreadySolved) return false;
  const p = solveState.puzzle;
  const playerPliesPlayed = Math.ceil(solveState.solverIdx / 2);
  if (playerPliesPlayed >= PLAYER_MOVES_TO_SOLVE || solveState.solverIdx >= p.solutionSan.length) {
    solveState.alreadySolved = true;
    recordPracticeOutcome(p.id, 'solved');
    return true;
  }
  return false;
}

// Switches into free play against the engine — used both for a wrong move
// and for "solved, keep exploring if you like." `scheduleReply` should be
// true when it's now the engine's turn to move (i.e. this was just called
// right after the player's own move).
function enterExploreMode(message, cls, scheduleReply) {
  solveState.branchMode = true;
  setSolveMode('branch');
  el('solveFeedback').textContent = message;
  el('solveFeedback').className = 'solve-feedback ' + cls;
  if (scheduleReply) scheduleEngineReplyIfAuto();
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
  scheduleEngineReplyIfAuto();
}

// Handles a move played by clicking the board while in branch mode — this
// covers both the player's own moves AND, when manual-opponent mode is on,
// moves the user picks on the opponent's behalf. Only schedule the engine's
// automatic reply if the move just played leaves the *opponent* to move;
// otherwise it's the player's own turn next and they'll move themselves.
function handleBranchMove(move) {
  const applied = solveState.board.applyUci(move.uci);
  if (!applied) return;
  pushHistory(applied.san, move.uci);
  if (solveState.board.chess.turn() !== solveState.puzzle.sideToMove) {
    scheduleEngineReplyIfAuto();
  }
}

// Schedules the engine's move for the opponent, unless manual-opponent mode
// is on — in which case the board just waits for the user to play it.
function scheduleEngineReplyIfAuto() {
  if (!solveState.manualOpponent) scheduleEngineReplyInBranch();
}

function scheduleEngineReplyInBranch() {
  const puzzleId = solveState.puzzle.id;
  setTimeout(async () => {
    if (!solveState || !solveState.branchMode || solveState.puzzle.id !== puzzleId || solveState.manualOpponent) return;
    if (solveState.board.chess.game_over()) return;
    const fen = solveState.board.chess.fen();
    let res;
    try {
      res = await engine.analyze(fen, { movetimeMs: 500 });
    } catch (e) { return; }
    if (!solveState || !solveState.branchMode || solveState.puzzle.id !== puzzleId || solveState.manualOpponent) return;
    if (res.bestMoveUci) {
      const applied = solveState.board.applyUci(res.bestMoveUci);
      if (applied) pushHistory(applied.san, res.bestMoveUci);
    }
  }, 450);
}

// ---------- Manual opponent mode ----------
// Lets the user take over the opponent's side for a turn (or several) to try
// out different replies, instead of the engine always playing them. Toggling
// back off hands the opponent's current turn (if any) straight back to the
// engine.
function toggleManualOpponent() {
  if (!solveState || !solveState.branchMode) return;
  solveState.manualOpponent = !solveState.manualOpponent;
  updateBranchControls();
  if (!solveState.manualOpponent && solveState.board.chess.turn() !== solveState.puzzle.sideToMove) {
    scheduleEngineReplyInBranch();
  }
}

function updateManualOpponentControls() {
  const btn = el('btnManualOpponent');
  const note = el('manualOpponentNote');
  if (!btn || !solveState) return;
  const disabled = !solveState.branchMode || solveState.viewingIndex !== null ||
    solveState.board.isPreviewing || solveState.board.chess.game_over();
  btn.disabled = disabled;
  const manual = !!solveState.manualOpponent;
  btn.textContent = manual ? 'Let computer play' : "Opponent's move";
  btn.classList.toggle('active', manual);
  if (!note) return;
  if (disabled || !manual) {
    note.textContent = '';
  } else {
    note.textContent = solveState.board.chess.turn() === solveState.puzzle.sideToMove
      ? 'Manual mode is on — the engine will wait for you to play the opponent too.'
      : "Manual mode is on — pick the opponent's move.";
  }
}

// ---------- Exploration hint ----------
// Lets the user ask the engine what it would play next — shown as an overlay
// arrow, without committing the move. Only makes sense on the live position,
// in branch mode, and only on a turn the user is actually about to play
// themselves: their own side always, or the opponent's side too while manual
// opponent mode is on (otherwise the engine's own reply is about to be
// applied automatically, so there's nothing to hint at).
function branchHintAvailable() {
  if (!solveState || !solveState.branchMode || solveState.viewingIndex !== null ||
    solveState.board.isPreviewing || solveState.board.chess.game_over()) return false;
  const turn = solveState.board.chess.turn();
  return turn === solveState.puzzle.sideToMove || !!solveState.manualOpponent;
}

function updateHintButton() {
  const btn = el('btnShowHint');
  if (!btn) return;
  btn.disabled = !branchHintAvailable();
  el('hintMoveLabel').textContent = '';
}

function updateBranchControls() {
  updateHintButton();
  updateManualOpponentControls();
}

async function showBranchHint() {
  if (!branchHintAvailable()) return;
  const board = solveState.board;
  const label = el('hintMoveLabel');
  const btn = el('btnShowHint');

  if (board.hintArrow) { board.clearHint(); label.textContent = ''; return; }

  const puzzleId = solveState.puzzle.id;
  const fen = board.chess.fen();
  btn.disabled = true;
  label.textContent = 'Thinking…';

  let res;
  try {
    res = await engine.analyze(fen, { movetimeMs: 700 });
  } catch (e) {
    label.textContent = '';
    btn.disabled = !branchHintAvailable();
    return;
  }
  // Bail out if the position moved on while we were waiting on the engine.
  if (!solveState || solveState.puzzle.id !== puzzleId || solveState.board.chess.fen() !== fen) return;

  if (res.bestMoveUci) {
    board.showHint(res.bestMoveUci);
    label.textContent = `Best: ${uciToSanAt(fen, res.bestMoveUci) || res.bestMoveUci}`;
  } else {
    label.textContent = 'No move found.';
  }
  btn.disabled = !branchHintAvailable();
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
  solveState.alreadySolved = true; // this attempt is recorded as failed, not solved
  solveState.viewingIndex = null;
  solveState.board.clearPreview();
  const p = solveState.puzzle;
  const remaining = p.solutionUci.slice(solveState.solverIdx);
  const remainingSan = p.solutionSan.slice(solveState.solverIdx);
  let i = 0;
  const step = () => {
    if (i >= remaining.length) {
      // Fully revealed — hand control back so the player can keep exploring
      // (and save whatever they find) instead of the board just freezing.
      const scheduleReply = solveState.board.chess.turn() !== solveState.puzzle.sideToMove;
      enterExploreMode(`Solution: ${p.solutionSan.join(' ')} — keep exploring if you like.`, 'wrong', scheduleReply);
      return;
    }
    solveState.board.applyUci(remaining[i]);
    pushHistory(remainingSan[i], remaining[i]);
    solveState.solverIdx++;
    updateSolveProgress();
    i++;
    setTimeout(step, 500);
  };
  el('solveFeedback').textContent = `Solution: ${p.solutionSan.join(' ')}`;
  el('solveFeedback').className = 'solve-feedback wrong';
  recordPracticeOutcome(p.id, 'failed');
  step();
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
    const source = p.manual ? escapeHtml(p.title || 'Custom position') : `vs ${escapeHtml(p.opponentUsername || '?')}`;
    return `<li class="clickable" data-puzzle-id="${p.id}"><span>${SEVERITY_LABEL[p.severity]} ${source}</span><span>${last === 'solved' ? '✓ solved' : '✗ not solved'} · ${new Date(r.lastAttemptAt).toLocaleDateString()}</span></li>`;
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

// ================= AI COACH (Hint on strategy) =================
// Blunder Atlas has no backend, so this calls Anthropic's Claude API
// directly from the browser using an API key the user supplies and pastes
// in themselves — stored only in this browser's localStorage, never sent
// anywhere but straight to Anthropic. Each hint is a small, per-use cost on
// the user's own Anthropic account, not something this app can subsidize.
const API_KEY_STORAGE_KEY = 'ba_claude_api_key';
const COACH_MODEL = 'claude-sonnet-5';

function getApiKey() {
  try { return localStorage.getItem(API_KEY_STORAGE_KEY) || ''; } catch (e) { return ''; }
}

function setApiKey(key) {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE_KEY, key);
    else localStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch (e) { /* private-browsing localStorage can throw — nothing to do */ }
}

function wireAiSettings() {
  el('btnSaveApiKey').addEventListener('click', () => {
    setApiKey(el('apiKeyInput').value.trim());
    toast('API key saved to this browser.');
  });
  el('btnClearApiKey').addEventListener('click', () => {
    setApiKey('');
    el('apiKeyInput').value = '';
    toast('API key cleared.');
  });
  el('btnStrategyHint').addEventListener('click', showStrategyHint);
}

function resetStrategyHint() {
  const box = el('strategyHintBox');
  box.hidden = true;
  box.textContent = '';
}

// Figures out which move-nav entry is currently "active" — the live end of
// the line by default, or whatever the user has scrubbed back to — and
// whether the move that led to it was the student's own (as opposed to the
// opponent's, or there being no move at all yet, at "Start"). That single
// fact decides which of the two coach actions below applies.
function getActiveMoveNavContext() {
  const reviewing = !!solveState.reviewingBranch;
  const h = reviewing ? solveState.reviewingBranch.history : solveState.history;
  const idx = solveState.viewingIndex === null ? h.length - 1 : solveState.viewingIndex;
  const entry = h[idx];
  const isPlayerMove = idx > 0 && entry.fen.split(' ')[1] !== solveState.puzzle.sideToMove;
  return { h, idx, entry, isPlayerMove };
}

// True if every move from ply 1 through `idx` exactly matches the puzzle's
// own stored solution line — i.e. the student hasn't deviated (yet). Used so
// the coach can reuse the puzzle's own precomputed answer instead of asking
// the engine fresh, which occasionally disagrees with it in close positions
// purely because the coach's live search runs for less time than the
// (possibly deeper) search used when the puzzle was first generated.
function movesMatchSolutionPrefix(h, idx, puzzle) {
  if (idx > puzzle.solutionUci.length) return false;
  for (let i = 1; i <= idx; i++) {
    if (h[i].uci !== puzzle.solutionUci[i - 1]) return false;
  }
  return true;
}

// Keeps the coach button's label matched to what's currently selected in the
// move-nav strip: "Explain this move" right after one of the student's own
// moves, "Strategy hint" everywhere else (Start, an opponent move, or the
// live position). Any previously-shown hint is cleared, since it no longer
// corresponds to what's now being looked at.
function updateStrategyHintButton() {
  const btn = el('btnStrategyHint');
  if (!btn || !solveState) return;
  const { isPlayerMove } = getActiveMoveNavContext();
  btn.textContent = isPlayerMove ? 'Explain this move' : 'Strategy hint';
  resetStrategyHint();
}

async function showStrategyHint() {
  if (!solveState) return;
  const apiKey = getApiKey();
  if (!apiKey) {
    toast('Add your Claude API key first, in the AI Coach tab.', 'error');
    showView('aicoach');
    return;
  }
  const { isPlayerMove } = getActiveMoveNavContext();
  if (isPlayerMove) await explainSelectedMove(apiKey);
  else await explainCurrentPosition(apiKey);
}

// Forward-looking: "what should be played from here" — for the live
// position, the puzzle's start, or an opponent move being looked at.
async function explainCurrentPosition(apiKey) {
  const box = el('strategyHintBox');
  const btn = el('btnStrategyHint');
  const puzzleId = solveState.puzzle.id;
  const { h, idx, entry } = getActiveMoveNavContext();
  const currentFen = entry.fen;
  btn.disabled = true;
  box.hidden = false;
  box.textContent = 'Thinking like a coach…';

  const p = solveState.puzzle;
  const fenParts = currentFen.split(' ');
  const turnColor = fenParts[1] === 'w' ? 'White' : 'Black';
  const moveNumber = parseInt(fenParts[5], 10) || p.moveNumber;

  let suggestedLine;
  if (movesMatchSolutionPrefix(h, idx, p) && idx < p.solutionSan.length) {
    // Still exactly on the puzzle's own solution line — reuse it verbatim
    // instead of re-asking the engine, so this always agrees with "Show
    // solution" rather than occasionally landing on a different top move.
    suggestedLine = buildMoveLabels(moveNumber, fenParts[1], p.solutionSan.slice(idx)).join(' ');
  } else {
    // Off the solution path (or past the end of it) — there's no stored
    // answer for this exact position anymore, so ask the engine fresh.
    let analysis;
    try {
      analysis = await engine.analyze(currentFen, { movetimeMs: 600 });
    } catch (e) {
      if (solveState && solveState.puzzle.id === puzzleId) { box.textContent = `Couldn't get a hint: ${e.message}`; btn.disabled = false; }
      return;
    }
    if (!solveState || solveState.puzzle.id !== puzzleId) return; // moved on while thinking

    if (!analysis.bestMoveUci) {
      box.textContent = 'The game has ended in this line — checkmate, stalemate, or a draw. Nothing further to find here.';
      btn.disabled = false;
      return;
    }

    const { sanList } = replayUciLine(currentFen, analysis.pvUci || [], 6);
    suggestedLine = sanList.length ? buildMoveLabels(moveNumber, fenParts[1], sanList).join(' ') : null;
  }

  const severityPhrase = p.severity === 'blunder' ? 'a blunder' : p.severity === 'mistake' ? 'a mistake' : 'an inaccuracy';
  const promptLines = [
    'You are a friendly, concise chess coach helping a student review a puzzle built from a mistake in their own game.',
    '',
    `This puzzle started from a position where, in the actual game, the student played ${p.playedSan || 'a different move'}, ${severityPhrase} that lost about ${p.cpLoss} centipawns of evaluation.`,
  ];
  if (idx > 0) {
    promptLines.push(`Since then, ${idx} move(s) have been played (either correctly solving the puzzle, or exploring a side line) — the position below is where things stand at the point being looked at right now, not the original starting position.`);
  }
  promptLines.push(
    '',
    `Position (FEN): ${currentFen}`,
    `It is ${turnColor} to move, and the student is the one to move next.`,
    suggestedLine
      ? `The engine's best continuation from this exact position is: ${suggestedLine}`
      : "The engine could not find a continuation from this exact position (it may already be decided).",
    '',
    "Write a short strategic hint (3-5 sentences) that helps the student find this continuation themselves, based on the position above. Describe the underlying tactical or positional idea — do NOT state the literal move(s) in algebraic notation or name specific destination squares as instructions to play. Focus on what to look for (weaknesses, undefended pieces, open lines, king safety, etc.) rather than dictating exact moves. Be warm and encouraging, like a coach guiding a student's thinking, not handing over the answer.",
  );
  await askCoach(promptLines.join('\n'), puzzleId, apiKey);
}

// Backward-looking: "why was this move (one of the student's own, already
// played) a good idea" — for a move-nav entry right after one of the
// student's own moves. Deliberately does not discuss the opponent's
// response or what to play next; it's scoped to explaining that one move.
async function explainSelectedMove(apiKey) {
  const box = el('strategyHintBox');
  const btn = el('btnStrategyHint');
  const puzzleId = solveState.puzzle.id;
  const { h, idx, entry } = getActiveMoveNavContext();
  const beforeFen = h[idx - 1].fen;
  btn.disabled = true;
  box.hidden = false;
  box.textContent = 'Thinking like a coach…';

  const colorName = beforeFen.split(' ')[1] === 'w' ? 'White' : 'Black';
  const p = solveState.puzzle;

  let bestSan, matchesEngine;
  if (movesMatchSolutionPrefix(h, idx, p)) {
    // This move IS the puzzle's own stored solution move at this point —
    // it's the engine's top choice by definition, no need to ask again.
    bestSan = p.solutionSan[idx - 1];
    matchesEngine = true;
  } else {
    let analysis;
    try {
      analysis = await engine.analyze(beforeFen, { movetimeMs: 600 });
    } catch (e) {
      if (solveState && solveState.puzzle.id === puzzleId) { box.textContent = `Couldn't get an explanation: ${e.message}`; btn.disabled = false; }
      return;
    }
    if (!solveState || solveState.puzzle.id !== puzzleId) return; // moved on while thinking

    bestSan = analysis.bestMoveUci ? (uciToSanAt(beforeFen, analysis.bestMoveUci) || analysis.bestMoveUci) : null;
    matchesEngine = !!(analysis.bestMoveUci && entry.uci && analysis.bestMoveUci.slice(0, 4) === entry.uci.slice(0, 4));
  }

  const promptLines = [
    'You are a friendly, concise chess coach helping a student understand a specific move they played while working through a puzzle from their own game.',
    '',
    `Position before the move (FEN): ${beforeFen}`,
    `It was ${colorName}'s move.`,
    `The student played: ${entry.san}`,
    matchesEngine
      ? "This matches the engine's own top choice from this position."
      : `The engine's top choice from this position was instead: ${bestSan || '(no clear best move found)'}.`,
    '',
    matchesEngine
      ? "Write a short explanation (3-5 sentences) of WHY this move is strong — the tactical or positional idea behind it — written like a coach confirming and reinforcing the student's good instinct."
      : "Write a short explanation (3-5 sentences) of the idea behind the engine's preferred move and, briefly, what the student's move may have missed by comparison. Be encouraging, not harsh.",
    "Do NOT describe what the opponent's best response would be, or advise on what to play next after this move — focus only on explaining THIS move itself.",
  ];
  await askCoach(promptLines.join('\n'), puzzleId, apiKey);
}

// Shared Claude call + result rendering for both coach actions above.
async function askCoach(prompt, puzzleId, apiKey) {
  const box = el('strategyHintBox');
  const btn = el('btnStrategyHint');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: COACH_MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!solveState || solveState.puzzle.id !== puzzleId) return; // moved on while waiting
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    const text = ((data && data.content) || []).map((block) => block.text || '').join('').trim();
    box.textContent = text || 'No hint returned.';
  } catch (e) {
    box.textContent = `Couldn't get a hint: ${e.message}`;
  } finally {
    if (solveState && solveState.puzzle.id === puzzleId) btn.disabled = false;
  }
}

// ================= INIT =================
async function init() {
  await DB.init();
  await refreshData();
  wireNav();
  wireImport();
  wireLibrary();
  wireSolve();
  wirePracticeSessionFilters();
  wireAiSettings();
  showView(allPuzzles.length ? 'library' : 'import');
  maybeAutoCheckForNewGames(); // fire-and-forget: runs quietly in the background
}

init();
