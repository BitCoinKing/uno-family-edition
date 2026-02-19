const COLORS = ["red", "yellow", "green", "blue"];
const ACTIONS = ["skip", "reverse", "draw2"];
const AI_NAMES = ["LILY", "LIA", "MILO", "ZOE", "MAX"];

let uidCounter = 1;

const nextUid = () => `card_${uidCounter++}`;

const shuffle = (cards) => {
  const copy = [...cards];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const normalizeName = (name) => name.trim().replace(/\s+/g, " ");

const cardLabel = (card) => {
  if (card.value === "draw2") return "+2";
  if (card.value === "wild4") return "+4";
  return String(card.value).toUpperCase();
};

export class GameEngine {
  constructor({ stateManager, eventBus, statsManager, soundManager }) {
    this.stateManager = stateManager;
    this.eventBus = eventBus;
    this.statsManager = statsManager;
    this.soundManager = soundManager;
  }

  createInitialGame(players, mode, roomCode = null, hostUserId = null) {
    let drawPile = this.createDeck();
    for (let i = 0; i < 7; i++) {
      players.forEach((player) => {
        player.hand.push(drawPile.pop());
      });
    }

    const discardPile = [];
    let starter = drawPile.pop();
    while (starter.type === "wild") {
      drawPile.unshift(starter);
      drawPile = shuffle(drawPile);
      starter = drawPile.pop();
    }
    discardPile.push(starter);

    const game = {
      id: `g_${Date.now()}`,
      mode,
      onlineReady: mode === "online",
      roomCode,
      hostUserId,
      players,
      drawPile,
      discardPile,
      currentTurn: 0,
      direction: 1,
      activeColor: starter.color,
      winnerId: null,
      moveHistory: [],
      startedAt: Date.now(),
      hasStarted: true,
    };

    this.applyStarterCard(game, starter);
    return game;
  }

  setScreen(screen) {
    this.stateManager.setState((state) => ({ ...state, screen }), "screen:changed");
  }

  updateSetup(setupPatch) {
    this.stateManager.setState((state) => ({
      ...state,
      setup: {
        ...state.setup,
        ...setupPatch,
      },
    }), "setup:changed");
  }

  openScoreboard(open) {
    this.stateManager.setState((state) => ({
      ...state,
      ui: {
        ...state.ui,
        scoreboardOpen: open,
      },
    }), "ui:changed");
  }

  openSettings(open) {
    this.stateManager.setState((state) => ({
      ...state,
      ui: {
        ...state.ui,
        settingsOpen: open,
      },
    }), "ui:changed");
  }

  leaveGame() {
    this.stateManager.setState((state) => ({
      ...state,
      screen: "landing",
      game: null,
      ui: {
        ...state.ui,
        scoreboardOpen: false,
        settingsOpen: false,
      },
    }), "game:left");
  }

  startGame({ playerNames, selectedPlayers, mode }) {
    const normalized = playerNames.map(normalizeName).filter(Boolean);
    if (normalized.length !== selectedPlayers) {
      return { ok: false, error: "Please enter all player names." };
    }

    const uniqueNames = new Set(normalized.map((n) => n.toLowerCase()));
    if (uniqueNames.size !== normalized.length) {
      return { ok: false, error: "Player names must be unique." };
    }

    let players = normalized.map((name, index) => ({
      id: `p_${index + 1}`,
      name,
      isAI: false,
      hand: [],
      oneCardWarning: false,
    }));

    if (selectedPlayers === 1) {
      const aiName = AI_NAMES.find((name) => !uniqueNames.has(name.toLowerCase())) || "CPU";
      players.push({
        id: "p_ai_1",
        name: aiName,
        isAI: true,
        hand: [],
        oneCardWarning: false,
      });
    }

    const game = this.createInitialGame(players, mode);

    this.stateManager.setState((state) => ({
      ...state,
      screen: "game",
      game,
      ui: {
        ...state.ui,
        scoreboardOpen: false,
        settingsOpen: false,
      },
    }), "game:started");

    this.eventBus.emit("game:turn", this.getTurnPayload(game));
    return { ok: true };
  }

  startOnlineGame({ lobbyPlayers, roomCode, hostUserId }) {
    if (!Array.isArray(lobbyPlayers) || lobbyPlayers.length < 2) {
      return { ok: false, error: "Need at least 2 players for online mode." };
    }

    const players = lobbyPlayers
      .sort((a, b) => a.player_index - b.player_index)
      .map((player, index) => ({
        id: `p_${index + 1}`,
        userId: player.user_id,
        name: player.display_name,
        isAI: false,
        hand: [],
        oneCardWarning: false,
      }));

    const game = this.createInitialGame(players, "online", roomCode, hostUserId);
    this.stateManager.setState((state) => ({
      ...state,
      screen: "game",
      game,
      ui: {
        ...state.ui,
        scoreboardOpen: false,
        settingsOpen: false,
      },
    }), "game:started");

    this.eventBus.emit("game:turn", this.getTurnPayload(game));
    return { ok: true, game };
  }

  serializeCurrentGame() {
    const game = this.stateManager.getState().game;
    return game ? JSON.parse(JSON.stringify(game)) : null;
  }

  applyRemoteGameState(remoteGame, eventName = "game:synced") {
    if (!remoteGame) return;
    const previousScreen = this.stateManager.getState().screen;
    const game = JSON.parse(JSON.stringify(remoteGame));
    this.stateManager.setState((state) => ({
      ...state,
      screen: "game",
      game,
      ui: {
        ...state.ui,
        turnBanner: game.winnerId
          ? "Winner"
          : `Turn: ${game.players[game.currentTurn]?.name || "-"}`,
      },
    }), eventName);
    if (previousScreen !== "game") {
      this.eventBus.emit("screen:changed");
    }

    if (game.winnerId) {
      const winner = game.players.find((p) => p.id === game.winnerId);
      this.eventBus.emit("game:feedback", {
        text: `${winner?.name || "Player"} wins!`,
        action: "win",
        winnerName: winner?.name || "Unknown",
      });
      return;
    }
    this.eventBus.emit("game:turn", this.getTurnPayload(game));
  }

  createDeck() {
    const deck = [];

    COLORS.forEach((color) => {
      deck.push({ id: nextUid(), type: "number", color, value: 0 });
      for (let n = 1; n <= 9; n++) {
        deck.push({ id: nextUid(), type: "number", color, value: n });
        deck.push({ id: nextUid(), type: "number", color, value: n });
      }
      ACTIONS.forEach((action) => {
        deck.push({ id: nextUid(), type: "action", color, value: action });
        deck.push({ id: nextUid(), type: "action", color, value: action });
      });
    });

    for (let i = 0; i < 4; i++) {
      deck.push({ id: nextUid(), type: "wild", color: "wild", value: "wild" });
      deck.push({ id: nextUid(), type: "wild", color: "wild", value: "wild4" });
    }

    return shuffle(deck);
  }

  isPlayable(card, game) {
    const top = game.discardPile[game.discardPile.length - 1];
    if (!top) return true;
    if (card.type === "wild") return true;
    return card.color === game.activeColor || card.value === top.value;
  }

  getCurrentPlayer(game) {
    return game.players[game.currentTurn];
  }

  getTurnPayload(game) {
    const player = this.getCurrentPlayer(game);
    return {
      gameId: game.id,
      turnIndex: game.currentTurn,
      playerId: player.id,
      userId: player.userId || null,
      playerName: player.name,
      isAI: player.isAI,
    };
  }

  applyStarterCard(game, starter) {
    if (starter.value === "skip") {
      game.currentTurn = this.nextTurnIndex(game, 1);
    }
    if (starter.value === "reverse") {
      game.direction *= -1;
      if (game.players.length === 2) {
        game.currentTurn = this.nextTurnIndex(game, 1);
      }
    }
    if (starter.value === "draw2") {
      const target = this.nextTurnIndex(game, 1);
      this.drawFor(game, target, 2);
      game.currentTurn = this.nextTurnIndex(game, 2);
    }
  }

  nextTurnIndex(game, steps = 1) {
    const n = game.players.length;
    let index = game.currentTurn;
    for (let i = 0; i < steps; i++) {
      index = (index + game.direction + n) % n;
    }
    return index;
  }

  drawFor(game, playerIndex, count) {
    for (let i = 0; i < count; i++) {
      if (game.drawPile.length === 0) this.restockDrawPile(game);
      const card = game.drawPile.pop();
      if (!card) break;
      game.players[playerIndex].hand.push(card);
    }
  }

  restockDrawPile(game) {
    if (game.discardPile.length <= 1) return;
    const top = game.discardPile.pop();
    game.drawPile = shuffle(game.discardPile);
    game.discardPile = [top];
  }

  drawCard(playerId, options = { passTurn: true }) {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game || game.winnerId) return { ok: false, error: "Game not active." };

    const player = this.getCurrentPlayer(game);
    if (player.id !== playerId) return { ok: false, error: "Not your turn." };

    if (game.drawPile.length === 0) this.restockDrawPile(game);
    const card = game.drawPile.pop();
    if (!card) return { ok: false, error: "No cards left to draw." };

    player.hand.push(card);
    game.moveHistory.push({
      type: "draw",
      playerId,
      cardId: card.id,
      at: Date.now(),
    });

    if (options.passTurn) {
      game.currentTurn = this.nextTurnIndex(game, 1);
      this.soundManager.playDraw();
      this.finalizeTick(game, "game:drawn", {
        text: `${player.name} drew a card`,
        action: "draw",
      });
      return { ok: true, card, turnEnded: true };
    }

    this.soundManager.playDraw();
    this.finalizeTick(game, "game:drawn", {
      text: `${player.name} drew a card`,
      action: "draw",
    });
    return { ok: true, card, turnEnded: false };
  }

  endTurn(playerId, reason = "pass") {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game || game.winnerId) return { ok: false, error: "Game not active." };

    const player = this.getCurrentPlayer(game);
    if (player.id !== playerId) return { ok: false, error: "Not your turn." };

    game.currentTurn = this.nextTurnIndex(game, 1);
    this.finalizeTick(game, "game:turnEnded", {
      text: `${player.name} ended turn`,
      action: reason,
    });
    return { ok: true };
  }

  playCard({ playerId, cardId, declaredColor }) {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game || game.winnerId) return { ok: false, error: "Game not active." };

    const player = this.getCurrentPlayer(game);
    if (player.id !== playerId) return { ok: false, error: "Not your turn." };

    const cardIndex = player.hand.findIndex((card) => card.id === cardId);
    if (cardIndex === -1) return { ok: false, error: "Card not found." };

    const card = player.hand[cardIndex];
    if (!this.isPlayable(card, game)) {
      return { ok: false, error: "Card is not playable." };
    }

    player.hand.splice(cardIndex, 1);
    const playedCard = {
      ...card,
      selectedColor: card.type === "wild" ? declaredColor || "red" : card.color,
    };

    game.discardPile.push(playedCard);
    game.activeColor = playedCard.selectedColor;
    game.moveHistory.push({
      type: "play",
      playerId,
      cardId: card.id,
      label: cardLabel(card),
      at: Date.now(),
    });

    this.statsManager.recordCardPlayed(player.name, card.type === "wild");
    this.emitMove({
      type: "play",
      playerId,
      card: playedCard,
      gameId: game.id,
    });

    player.oneCardWarning = player.hand.length === 1;

    if (player.hand.length === 0) {
      game.winnerId = player.id;
      this.soundManager.playWin();
      this.statsManager.recordGame(game.players, player.id);
      this.finalizeTick(game, "game:won", {
        text: `${player.name} wins!`,
        action: "win",
        winnerName: player.name,
      });
      return { ok: true };
    }

    this.applyCardEffect(game, playedCard);
    this.finalizeTick(game, "game:played", {
      text: `${player.name} played ${cardLabel(playedCard)}`,
      action: playedCard.value,
      card: playedCard,
    });
    return { ok: true };
  }

  applyCardEffect(game, card) {
    if (card.type === "number") {
      game.currentTurn = this.nextTurnIndex(game, 1);
      this.soundManager.playCard();
      return;
    }

    if (card.value === "skip") {
      game.currentTurn = this.nextTurnIndex(game, 2);
      this.soundManager.playSkip();
      return;
    }

    if (card.value === "reverse") {
      game.direction *= -1;
      const steps = game.players.length === 2 ? 2 : 1;
      game.currentTurn = this.nextTurnIndex(game, steps);
      this.soundManager.playReverse();
      return;
    }

    if (card.value === "draw2") {
      const target = this.nextTurnIndex(game, 1);
      this.drawFor(game, target, 2);
      game.currentTurn = this.nextTurnIndex(game, 2);
      this.soundManager.playSkip();
      return;
    }

    if (card.value === "wild") {
      game.currentTurn = this.nextTurnIndex(game, 1);
      this.soundManager.playWild();
      return;
    }

    if (card.value === "wild4") {
      const target = this.nextTurnIndex(game, 1);
      this.drawFor(game, target, 4);
      game.currentTurn = this.nextTurnIndex(game, 2);
      this.soundManager.playWild();
    }
  }

  emitMove(move) {
    this.eventBus.emit("game:move", move);
  }

  finalizeTick(game, eventName, feedback) {
    this.stateManager.setState((state) => ({
      ...state,
      game: {
        ...game,
      },
      ui: {
        ...state.ui,
        turnBanner: game.winnerId
          ? `Winner: ${feedback.winnerName}`
          : `Turn: ${game.players[game.currentTurn].name}`,
      },
    }), eventName);

    this.eventBus.emit("game:feedback", feedback);
    if (!game.winnerId) {
      this.eventBus.emit("game:turn", this.getTurnPayload(game));
      this.soundManager.playTurnNotification();
    }
  }
}
