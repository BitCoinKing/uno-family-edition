export class AIEngine {
  constructor({ eventBus, stateManager, gameEngine }) {
    this.eventBus = eventBus;
    this.stateManager = stateManager;
    this.gameEngine = gameEngine;
    this.turnTimer = null;
    this.unsubscribe = this.eventBus.on("game:turn", (payload) => this.onTurn(payload));
  }

  onTurn(payload) {
    if (!payload?.isAI) return;
    if (this.turnTimer) clearTimeout(this.turnTimer);

    const delay = 700 + Math.floor(Math.random() * 700);
    this.turnTimer = setTimeout(() => this.takeTurn(payload.playerId), delay);
  }

  takeTurn(playerId) {
    const game = this.stateManager.getState().game;
    if (!game || game.winnerId) return;

    const player = game.players[game.currentTurn];
    if (!player || player.id !== playerId || !player.isAI) return;

    const playable = player.hand.filter((card) => this.gameEngine.isPlayable(card, game));

    if (playable.length === 0) {
      const drawResult = this.gameEngine.drawCard(playerId, { passTurn: false });
      if (!drawResult.ok) return;

      const drawnCard = drawResult.card;
      if (drawnCard && this.gameEngine.isPlayable(drawnCard, this.stateManager.getState().game)) {
        const color = drawnCard.type === "wild" ? this.pickColor(player.hand) : null;
        this.gameEngine.playCard({
          playerId,
          cardId: drawnCard.id,
          declaredColor: color,
        });
      } else {
        this.gameEngine.endTurn(playerId, "pass");
      }
      return;
    }

    const chosen = this.chooseCard(playable, game);
    const declaredColor = chosen.type === "wild" ? this.pickColor(player.hand) : null;

    this.gameEngine.playCard({
      playerId,
      cardId: chosen.id,
      declaredColor,
    });
  }

  chooseCard(cards, game) {
    const players = game.players;
    const nextPlayer = players[(game.currentTurn + game.direction + players.length) % players.length];
    const nextHasFewCards = nextPlayer.hand.length <= 2;

    const scored = cards.map((card) => {
      let score = 0;

      if (card.color === game.activeColor) score += 7;
      if (card.type === "action") score += 4;
      if (card.value === "draw2") score += nextHasFewCards ? 7 : 5;
      if (card.value === "skip") score += nextHasFewCards ? 6 : 3;
      if (card.value === "reverse") score += players.length === 2 ? 5 : 3;
      if (card.value === "wild4") score += nextHasFewCards ? 8 : 4;
      if (card.value === "wild") score += 2;

      score += Math.random() * 2.6;
      return { card, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].card;
  }

  pickColor(hand) {
    const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
    hand.forEach((card) => {
      if (counts[card.color] !== undefined) counts[card.color] += 1;
    });

    let best = "red";
    let top = -1;
    for (const color of Object.keys(counts)) {
      if (counts[color] > top) {
        top = counts[color];
        best = color;
      }
    }
    return best;
  }
}
