const STORAGE_KEY = "uno_family_stats_v1";

export class StatsManager {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.stats = this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stats));
    } catch {
      // Ignore storage failures.
    }
    this.eventBus.emit("stats:updated", this.getLeaderboard());
  }

  ensurePlayer(name) {
    if (!this.stats[name]) {
      this.stats[name] = {
        name,
        gamesPlayed: 0,
        gamesWon: 0,
        winPct: 0,
        totalCardsPlayed: 0,
        totalWildCardsUsed: 0,
      };
    }
    return this.stats[name];
  }

  recordCardPlayed(name, isWild) {
    const player = this.ensurePlayer(name);
    player.totalCardsPlayed += 1;
    if (isWild) player.totalWildCardsUsed += 1;
    this.updatePct(player);
    this.save();
  }

  recordGame(players, winnerId) {
    players.forEach((player) => {
      const p = this.ensurePlayer(player.name);
      p.gamesPlayed += 1;
      if (player.id === winnerId) p.gamesWon += 1;
      this.updatePct(p);
    });
    this.save();
  }

  updatePct(player) {
    player.winPct = player.gamesPlayed === 0
      ? 0
      : Number(((player.gamesWon / player.gamesPlayed) * 100).toFixed(1));
  }

  getLeaderboard() {
    return Object.values(this.stats).sort((a, b) => {
      if (b.gamesWon !== a.gamesWon) return b.gamesWon - a.gamesWon;
      if (b.winPct !== a.winPct) return b.winPct - a.winPct;
      return b.totalCardsPlayed - a.totalCardsPlayed;
    });
  }
}
