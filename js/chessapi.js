// Chess.com public API client (no auth required, read-only).
const ChessApi = {
  async fetchArchives(username) {
    const res = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`);
    if (res.status === 404) throw new Error(`No chess.com account found for "${username}".`);
    if (!res.ok) throw new Error(`Chess.com API error (${res.status}).`);
    const data = await res.json();
    return data.archives || [];
  },

  async fetchArchiveGames(archiveUrl) {
    const res = await fetch(archiveUrl);
    if (!res.ok) throw new Error(`Failed to fetch archive: ${archiveUrl}`);
    const data = await res.json();
    return data.games || [];
  },

  // Fetches games within the given scope: { unit: 'months', amount } fetches
  // the most recent `amount` monthly archives (amount >= 999 means "everything");
  // { unit: 'days', amount } fetches the last two monthly archives (enough to
  // cover any day/week window) and filters games by end_time.
  // onProgress(current, total, label)
  async importRecentGames(username, scope, onProgress) {
    const archives = await this.fetchArchives(username);
    let chosen;
    if (scope.unit === 'days') {
      chosen = archives.slice(Math.max(0, archives.length - 2));
    } else if (scope.amount >= 999) {
      chosen = archives;
    } else {
      chosen = archives.slice(Math.max(0, archives.length - scope.amount));
    }

    const all = [];
    for (let i = 0; i < chosen.length; i++) {
      const url = chosen[i];
      const label = url.split('/').slice(-2).join('-');
      if (onProgress) onProgress(i, chosen.length, `Fetching ${label}...`);
      const games = await this.fetchArchiveGames(url);
      all.push(...games);
    }
    if (onProgress) onProgress(chosen.length, chosen.length, 'Done fetching archives.');

    if (scope.unit === 'days') {
      const cutoff = Math.floor(Date.now() / 1000) - scope.amount * 86400;
      return all.filter((g) => (g.end_time || 0) >= cutoff);
    }
    return all;
  },
};
