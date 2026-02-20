const COLORS = ["red", "yellow", "green", "blue"];
const ACTIONS = ["skip", "reverse", "draw2"];
const AI_NAMES = ["LILY", "LIA", "MILO", "ZOE", "MAX"];
const UNO_CALL_WINDOW_MS = 1000;

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

const cloneDeep = (value) => JSON.parse(JSON.stringify(value));

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
    while (starter?.type === "wild") {
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
      discardTop: starter,
      drawPileCount: drawPile.length,
      currentTurn: 0,
      direction: 1,
      activeColor: starter?.color || "red",
      winnerId: null,
      moveHistory: [],
      startedAt: Date.now(),
      hasStarted: true,
      allowDrawWhenPlayable: true,
      turnState: this.createTurnState(),
      pendingUnoPlayerId: null,
      pendingUnoDeadlineAt: null,
      roundPoints: 0,
    };

    this.normalizeGameState(game);
    this.applyStarterCard(game, starter);
    this.syncPlayerWarnings(game);
    this.syncDerivedState(game);
    return game;
  }

  createTurnState(patch = {}) {
    return {
      hasDrawnThisTurn: false,
      drawnCardId: null,
      drawnCardPlayable: false,
      ...patch,
    };
  }

  normalizeGameState(game) {
    if (!game) return;

    game.players = Array.isArray(game.players) ? game.players : [];
    game.players.forEach((player, index) => {
      if (!player.id) player.id = `p_${index + 1}`;
      if (!Array.isArray(player.hand)) player.hand = [];
      if (typeof player.name !== "string") player.name = `Player ${index + 1}`;
      if (typeof player.oneCardWarning !== "boolean") {
        player.oneCardWarning = player.hand.length === 1;
      }
      if (typeof player.mustCallUno !== "boolean") {
        player.mustCallUno = false;
      }
    });

    if (!Array.isArray(game.drawPile)) game.drawPile = [];
    if (!Array.isArray(game.discardPile)) game.discardPile = [];
    if (!Array.isArray(game.moveHistory)) game.moveHistory = [];

    if (!Number.isFinite(game.currentTurn) || game.currentTurn < 0 || game.currentTurn >= game.players.length) {
      game.currentTurn = 0;
    }

    game.direction = game.direction === -1 ? -1 : 1;

    if (!game.turnState || typeof game.turnState !== "object") {
      game.turnState = this.createTurnState();
    } else {
      game.turnState = this.createTurnState(game.turnState);
    }

    if (!Object.prototype.hasOwnProperty.call(game, "pendingUnoPlayerId")) {
      game.pendingUnoPlayerId = null;
    }
    if (!Object.prototype.hasOwnProperty.call(game, "pendingUnoDeadlineAt")) {
      game.pendingUnoDeadlineAt = null;
    }

    if (!game.activeColor) {
      const top = game.discardPile[game.discardPile.length - 1];
      game.activeColor = top?.selectedColor || top?.color || "red";
    }

    this.syncDerivedState(game);
  }

  syncDerivedState(game) {
    if (!game) return;
    const top = game.discardPile?.[game.discardPile.length - 1] || null;
    game.discardTop = top;
    game.drawPileCount = Array.isArray(game.drawPile) ? game.drawPile.length : 0;
    if (!game.activeColor && top) {
      game.activeColor = top.selectedColor || top.color;
    }
  }

  syncPlayerWarnings(game) {
    if (!game?.players) return;
    game.players.forEach((player) => {
      const isOneCard = player.hand.length === 1;
      player.oneCardWarning = isOneCard;
      if (!isOneCard) {
        player.mustCallUno = false;
      }
    });
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
      mustCallUno: false,
    }));

    if (selectedPlayers === 1) {
      const aiName = AI_NAMES.find((candidate) => !uniqueNames.has(candidate.toLowerCase())) || "CPU";
      players.push({
        id: "p_ai_1",
        name: aiName,
        isAI: true,
        hand: [],
        oneCardWarning: false,
        mustCallUno: false,
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
        mustCallUno: false,
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
    return game ? cloneDeep(game) : null;
  }

  applyRemoteGameState(remoteGame, eventName = "game:synced") {
    if (!remoteGame) return;
    const previousScreen = this.stateManager.getState().screen;
    const game = cloneDeep(remoteGame);
    this.normalizeGameState(game);

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

  isPlayable(card, game, player = null) {
    if (!card || !game) return false;

    const top = game.discardPile[game.discardPile.length - 1];
    if (!top) return true;

    if (card.type === "wild") {
      if (card.value === "wild4" && player) {
        return this.canPlayWildDrawFour(player, card.id, game);
      }
      return true;
    }

    return card.color === game.activeColor || card.value === top.value;
  }

  canPlayWildDrawFour(player, cardId, game) {
    if (!player || !Array.isArray(player.hand)) return false;
    return !player.hand.some((handCard) => handCard.id !== cardId && handCard.color === game.activeColor);
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
    if (!starter) return;

    if (starter.value === "skip") {
      this.moveTurn(game, 1);
      return;
    }

    if (starter.value === "reverse") {
      game.direction *= -1;
      const steps = game.players.length === 2 ? 2 : 1;
      this.moveTurn(game, steps);
      return;
    }

    if (starter.value === "draw2") {
      const target = this.nextTurnIndex(game, 1);
      this.drawFor(game, target, 2);
      this.moveTurn(game, 2);
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

  setCurrentTurn(game, nextIndex) {
    game.currentTurn = nextIndex;
    game.turnState = this.createTurnState();
  }

  moveTurn(game, steps = 1) {
    const nextIndex = this.nextTurnIndex(game, steps);
    this.setCurrentTurn(game, nextIndex);
  }

  drawFor(game, playerIndex, count) {
    for (let i = 0; i < count; i++) {
      if (game.drawPile.length === 0) this.restockDrawPile(game);
      const card = game.drawPile.pop();
      if (!card) break;
      game.players[playerIndex].hand.push(card);
    }
    this.syncDerivedState(game);
  }

  restockDrawPile(game) {
    if (game.discardPile.length <= 1) return;
    const top = game.discardPile.pop();
    game.drawPile = shuffle(game.discardPile);
    game.discardPile = [top];
    this.syncDerivedState(game);
  }

  clearPendingUno(game) {
    if (!game) return;
    game.pendingUnoPlayerId = null;
    game.pendingUnoDeadlineAt = null;
  }

  setPendingUno(game, playerId) {
    this.clearPendingUno(game);
    const player = game.players.find((entry) => entry.id === playerId);
    if (!player || player.hand.length !== 1) return;

    player.mustCallUno = true;
    player.oneCardWarning = true;
    game.pendingUnoPlayerId = playerId;
    game.pendingUnoDeadlineAt = Date.now() + UNO_CALL_WINDOW_MS;
  }

  applyPendingUnoPenaltyIfNeeded(game, actorPlayerId = null) {
    if (!game?.pendingUnoPlayerId || !game.pendingUnoDeadlineAt) {
      return null;
    }

    const deadlinePassed = Date.now() >= game.pendingUnoDeadlineAt;
    const nextActorMoved = !!actorPlayerId && actorPlayerId !== game.pendingUnoPlayerId;
    const pendingPlayerMovedWithoutCalling = !!actorPlayerId && actorPlayerId === game.pendingUnoPlayerId;
    if (!deadlinePassed && !nextActorMoved && !pendingPlayerMovedWithoutCalling) {
      return null;
    }

    const penalizedIndex = game.players.findIndex((player) => player.id === game.pendingUnoPlayerId);
    const penalizedPlayer = penalizedIndex >= 0 ? game.players[penalizedIndex] : null;

    this.clearPendingUno(game);

    if (!penalizedPlayer || !penalizedPlayer.mustCallUno || penalizedPlayer.hand.length !== 1) {
      return null;
    }

    this.drawFor(game, penalizedIndex, 2);
    penalizedPlayer.mustCallUno = false;
    penalizedPlayer.oneCardWarning = penalizedPlayer.hand.length === 1;
    game.moveHistory.push({
      type: "uno_penalty",
      playerId: penalizedPlayer.id,
      cards: 2,
      at: Date.now(),
    });

    this.syncPlayerWarnings(game);
    this.syncDerivedState(game);

    return {
      playerId: penalizedPlayer.id,
      playerName: penalizedPlayer.name,
    };
  }

  drawCard(playerId) {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game || game.winnerId) return { ok: false, error: "Game not active." };

    this.normalizeGameState(game);

    const penalty = this.applyPendingUnoPenaltyIfNeeded(game, playerId);

    const player = this.getCurrentPlayer(game);
    if (!player || player.id !== playerId) return { ok: false, error: "Not your turn." };

    if (game.turnState.hasDrawnThisTurn) {
      return { ok: false, error: "You already drew this turn. Play a card or pass." };
    }

    if (game.drawPile.length === 0) this.restockDrawPile(game);
    const card = game.drawPile.pop();
    if (!card) return { ok: false, error: "No cards left to draw." };

    player.hand.push(card);

    const playable = this.isPlayable(card, game, player);
    game.turnState = this.createTurnState({
      hasDrawnThisTurn: true,
      drawnCardId: card.id,
      drawnCardPlayable: playable,
    });

    game.moveHistory.push({
      type: "draw",
      playerId,
      cardId: card.id,
      playable,
      at: Date.now(),
    });

    this.syncPlayerWarnings(game);
    this.syncDerivedState(game);
    this.soundManager.playDraw();

    if (!playable) {
      this.moveTurn(game, 1);
      this.finalizeTick(game, "game:drawn", {
        text: this.appendPenaltyText(
          `${player.name} drew a card and turn passed`,
          penalty,
        ),
        action: "draw",
      }, {
        emitTurn: true,
      });
      return { ok: true, card, turnEnded: true, canPlay: false };
    }

    this.finalizeTick(game, "game:drawn", {
      text: this.appendPenaltyText(
        `${player.name} drew a card and can play or pass`,
        penalty,
      ),
      action: "draw",
    }, {
      emitTurn: false,
    });

    return { ok: true, card, turnEnded: false, canPlay: true };
  }

  endTurn(playerId, reason = "pass") {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game || game.winnerId) return { ok: false, error: "Game not active." };

    this.normalizeGameState(game);

    const penalty = this.applyPendingUnoPenaltyIfNeeded(game, playerId);

    const player = this.getCurrentPlayer(game);
    if (!player || player.id !== playerId) return { ok: false, error: "Not your turn." };

    if (reason === "pass" && !game.turnState.hasDrawnThisTurn) {
      return { ok: false, error: "Draw a card before passing." };
    }

    this.moveTurn(game, 1);
    this.finalizeTick(game, "game:turnEnded", {
      text: this.appendPenaltyText(`${player.name} ended turn`, penalty),
      action: reason,
    }, {
      emitTurn: true,
    });
    return { ok: true };
  }

  callUno(playerId) {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game || game.winnerId) return { ok: false, error: "Game not active." };

    this.normalizeGameState(game);

    if (!game.pendingUnoPlayerId || game.pendingUnoPlayerId !== playerId) {
      return { ok: false, error: "UNO call is not needed right now." };
    }

    if (Date.now() > (game.pendingUnoDeadlineAt || 0)) {
      const penalty = this.applyPendingUnoPenaltyIfNeeded(game);
      if (penalty) {
        this.finalizeTick(game, "game:unoPenalty", {
          text: `${penalty.playerName} failed to call UNO and drew 2 cards.`,
          action: "uno_penalty",
        }, {
          emitTurn: false,
        });
      }
      return { ok: false, error: "Too late. UNO penalty applied." };
    }

    const player = game.players.find((entry) => entry.id === playerId);
    if (!player) return { ok: false, error: "Player not found." };

    player.mustCallUno = false;
    player.oneCardWarning = player.hand.length === 1;
    this.clearPendingUno(game);
    game.moveHistory.push({
      type: "call_uno",
      playerId,
      at: Date.now(),
    });

    this.finalizeTick(game, "game:unoCalled", {
      text: `${player.name} called UNO!`,
      action: "uno",
    }, {
      emitTurn: false,
    });

    return { ok: true };
  }

  playCard({ playerId, cardId, declaredColor }) {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game || game.winnerId) return { ok: false, error: "Game not active." };

    this.normalizeGameState(game);

    const penalty = this.applyPendingUnoPenaltyIfNeeded(game, playerId);

    const player = this.getCurrentPlayer(game);
    if (!player || player.id !== playerId) return { ok: false, error: "Not your turn." };

    const cardIndex = player.hand.findIndex((card) => card.id === cardId);
    if (cardIndex === -1) return { ok: false, error: "Card not found." };

    const card = player.hand[cardIndex];
    const isWildDrawFour = card.type === "wild" && card.value === "wild4";
    if (isWildDrawFour && !this.canPlayWildDrawFour(player, card.id, game)) {
      return { ok: false, error: "Wild Draw Four requires no card matching the active color." };
    }

    const playable = this.isPlayable(card, game, isWildDrawFour ? null : player);
    if (!playable) return { ok: false, error: "Card is not playable." };

    if (card.type === "wild") {
      if (!declaredColor || !COLORS.includes(declaredColor)) {
        return { ok: false, error: "Choose a valid color first." };
      }
    }

    player.hand.splice(cardIndex, 1);

    const playedCard = {
      ...card,
      selectedColor: card.type === "wild" ? declaredColor : card.color,
    };

    game.discardPile.push(playedCard);
    game.activeColor = playedCard.selectedColor;
    game.turnState = this.createTurnState();
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

    if (player.hand.length === 1) {
      this.setPendingUno(game, player.id);
    } else if (game.pendingUnoPlayerId === player.id) {
      this.clearPendingUno(game);
      player.mustCallUno = false;
    }

    if (player.hand.length === 0) {
      game.winnerId = player.id;
      player.mustCallUno = false;
      this.clearPendingUno(game);
      this.soundManager.playWin();
      this.statsManager.recordGame(game.players, player.id);
      game.roundPoints = this.calculateRoundPoints(game, player.id);
      this.finalizeTick(game, "game:won", {
        text: `${player.name} wins! +${game.roundPoints} points`,
        action: "win",
        winnerName: player.name,
        roundPoints: game.roundPoints,
      }, {
        emitTurn: false,
      });
      return { ok: true };
    }

    this.applyCardEffect(game, playedCard);
    const unoSuffix = player.mustCallUno ? " (UNO pending)" : "";
    this.finalizeTick(game, "game:played", {
      text: this.appendPenaltyText(
        `${player.name} played ${cardLabel(playedCard)}${unoSuffix}`,
        penalty,
      ),
      action: playedCard.value,
      card: playedCard,
    }, {
      emitTurn: true,
    });
    return { ok: true };
  }

  calculateRoundPoints(game, winnerId) {
    return game.players
      .filter((player) => player.id !== winnerId)
      .reduce((total, player) => {
        return total + player.hand.reduce((sum, card) => sum + this.cardPoints(card), 0);
      }, 0);
  }

  cardPoints(card) {
    if (!card) return 0;
    if (card.type === "number") return Number(card.value) || 0;
    if (card.type === "wild") return 50;
    return 20;
  }

  applyCardEffect(game, card) {
    if (card.type === "number") {
      this.moveTurn(game, 1);
      this.soundManager.playCard();
      return;
    }

    if (card.value === "skip") {
      this.moveTurn(game, 2);
      this.soundManager.playSkip();
      return;
    }

    if (card.value === "reverse") {
      game.direction *= -1;
      const steps = game.players.length === 2 ? 2 : 1;
      this.moveTurn(game, steps);
      this.soundManager.playReverse();
      return;
    }

    if (card.value === "draw2") {
      const target = this.nextTurnIndex(game, 1);
      this.drawFor(game, target, 2);
      this.moveTurn(game, 2);
      this.soundManager.playSkip();
      return;
    }

    if (card.value === "wild") {
      this.moveTurn(game, 1);
      this.soundManager.playWild();
      return;
    }

    if (card.value === "wild4") {
      const target = this.nextTurnIndex(game, 1);
      this.drawFor(game, target, 4);
      this.moveTurn(game, 2);
      this.soundManager.playWild();
    }
  }

  appendPenaltyText(base, penalty) {
    if (!penalty?.playerName) return base;
    return `${base}. ${penalty.playerName} failed UNO and drew 2.`;
  }

  emitMove(move) {
    this.eventBus.emit("game:move", move);
  }

  finalizeTick(game, eventName, feedback, options = {}) {
    const { emitTurn = true } = options;

    this.syncPlayerWarnings(game);
    this.syncDerivedState(game);

    const nextTurnName = game.players[game.currentTurn]?.name || "-";

    this.stateManager.setState((state) => ({
      ...state,
      game: {
        ...game,
      },
      ui: {
        ...state.ui,
        turnBanner: game.winnerId
          ? `Winner: ${feedback.winnerName || "-"}`
          : `Turn: ${nextTurnName}`,
      },
    }), eventName);

    this.eventBus.emit("game:feedback", feedback);
    if (!game.winnerId && emitTurn) {
      this.eventBus.emit("game:turn", this.getTurnPayload(game));
      this.soundManager.playTurnNotification();
    }

    console.log("[GAME]", {
      mode: game.mode,
      currentTurn: game.currentTurn,
      activeColor: game.activeColor,
      discardTop: game.discardTop?.value ?? null,
      event: eventName,
      pendingUnoPlayerId: game.pendingUnoPlayerId,
    });
  }
}
