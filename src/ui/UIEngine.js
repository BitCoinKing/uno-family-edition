const COLOR_ORDER = ["red", "yellow", "green", "blue"];

const cardText = (card) => {
  if (card.value === "draw2") return "+2";
  if (card.value === "wild4") return "+4";
  if (card.value === "wild") return "WILD";
  if (card.value === "skip") return "SKIP";
  if (card.value === "reverse") return "REV";
  return String(card.value);
};

export class UIEngine {
  constructor({
    root,
    stateManager,
    eventBus,
    gameEngine,
    authManager,
    onlineEngine,
    statsManager,
    animationEngine,
    particleEngine,
    soundManager,
  }) {
    this.root = root;
    this.stateManager = stateManager;
    this.eventBus = eventBus;
    this.gameEngine = gameEngine;
    this.authManager = authManager;
    this.onlineEngine = onlineEngine;
    this.statsManager = statsManager;
    this.animationEngine = animationEngine;
    this.particleEngine = particleEngine;
    this.soundManager = soundManager;

    this.nodes = {};
    this.pendingWild = null;
    this.feedbackTimer = null;
    this.lastSetupCount = null;

    this.bindEvents();
  }

  bindEvents() {
    this.eventBus.on("screen:changed", () => this.renderScreen());
    this.eventBus.on("setup:changed", () => this.updateSetupFields());
    this.eventBus.on("game:started", () => this.renderScreen());
    this.eventBus.on("game:played", () => this.updateGame());
    this.eventBus.on("game:drawn", () => this.updateGame());
    this.eventBus.on("game:turnEnded", () => this.updateGame());
    this.eventBus.on("game:won", () => this.updateGame());
    this.eventBus.on("game:synced", () => this.updateGame());
    this.eventBus.on("ui:changed", () => this.updateOverlays());
    this.eventBus.on("game:left", () => this.renderScreen());
    this.eventBus.on("stats:updated", () => this.updateScoreboardTable());
    this.eventBus.on("auth:state", () => this.updateSetupOnlinePanel());
    this.eventBus.on("online:autojoined", (payload) => {
      this.showToast(`Joined room ${payload.roomCode} from invite link.`);
    });
    this.eventBus.on("online:autojoin-failed", (payload) => {
      if (this.nodes.error) this.nodes.error.textContent = payload.error;
    });

    this.eventBus.on("game:feedback", (payload) => this.handleFeedback(payload));
    this.eventBus.on("game:turn", (payload) => this.handleTurn(payload));
  }

  mount() {
    this.renderScreen();
  }

  renderScreen() {
    const state = this.stateManager.getState();
    const screen = state.screen;

    if (screen === "landing") {
      this.root.innerHTML = this.landingTemplate();
      this.bindLandingEvents();
      return;
    }

    if (screen === "setup") {
      this.root.innerHTML = this.setupTemplate(state.setup);
      this.cacheSetupNodes();
      this.bindSetupEvents();
      this.updateSetupFields();
      return;
    }

    if (screen === "game") {
      this.root.innerHTML = this.gameTemplate();
      this.cacheGameNodes();
      this.bindGameEvents();
      this.updateGame();
    }
  }

  landingTemplate() {
    return `
      <section class="screen landing-screen fade-in">
        <div class="landing-content">
          <h1>UNO - Family Edition</h1>
          <p class="subtitle">A polished family battle with local players, AI, and online-ready architecture.</p>
          <button id="start-game-btn" class="btn primary">Play</button>
        </div>
      </section>
    `;
  }

  setupTemplate(setup) {
    return `
      <section class="screen setup-screen fade-in">
        <div class="panel setup-panel">
          <h2>Game Setup</h2>
          <div class="setup-grid">
            <label id="player-count-label">
              Players
              <select id="player-count" class="input">
                ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${setup.selectedPlayers === n ? "selected" : ""}>${n}</option>`).join("")}
              </select>
            </label>
            <p id="player-count-locked" class="small-text hidden"></p>

            <div class="mode-toggle">
              <button id="mode-local" class="btn ${setup.mode === "local" ? "active" : ""}">Local Multiplayer</button>
              <button id="mode-online" class="btn ${setup.mode === "online" ? "active" : ""}">Online Multiplayer</button>
            </div>
          </div>

          <p id="setup-note" class="setup-note"></p>

          <div id="player-name-fields" class="name-fields slide-in"></div>
          <div id="online-panel" class="online-panel hidden"></div>

          <div class="setup-actions">
            <button id="back-to-landing" class="btn ghost">Back</button>
            <button id="start-match" class="btn primary">Start Match</button>
          </div>

          <p id="setup-error" class="error-text"></p>
        </div>
      </section>
    `;
  }

  gameTemplate() {
    return `
      <section class="screen game-screen fade-in">
        <header class="game-header">
          <div class="left-head">
            <strong id="direction-pill" class="pill">Direction: Clockwise</strong>
          </div>
          <div id="turn-banner" class="turn-banner">Turn: -</div>
          <div class="right-head">
            <button id="open-scoreboard" class="btn">Scoreboard</button>
            <button id="open-settings" class="btn">Settings</button>
            <button id="leave-game" class="btn danger">Leave</button>
          </div>
        </header>

        <main class="table-wrap">
          <section id="players-grid" class="players-grid"></section>
          <section class="center-zone">
            <button id="draw-card" class="deck-card">Draw</button>
            <div id="discard-card" class="uno-card discard-card">?</div>
            <p id="pile-meta" class="pile-meta">Deck: 0</p>
          </section>
          <p id="feedback-text" class="feedback-text"></p>
        </main>

        <div id="scoreboard-modal" class="modal hidden"></div>
        <div id="settings-modal" class="modal hidden"></div>
        <div id="wild-modal" class="modal hidden"></div>
        <div id="win-overlay" class="win-overlay hidden"></div>
        <div id="toast-alert" class="toast-alert"></div>
      </section>
    `;
  }

  cacheSetupNodes() {
    this.nodes.playerCount = this.root.querySelector("#player-count");
    this.nodes.playerCountLabel = this.root.querySelector("#player-count-label");
    this.nodes.playerCountLocked = this.root.querySelector("#player-count-locked");
    this.nodes.nameFields = this.root.querySelector("#player-name-fields");
    this.nodes.onlinePanel = this.root.querySelector("#online-panel");
    this.nodes.note = this.root.querySelector("#setup-note");
    this.nodes.error = this.root.querySelector("#setup-error");
  }

  cacheGameNodes() {
    this.nodes.turnBanner = this.root.querySelector("#turn-banner");
    this.nodes.playersGrid = this.root.querySelector("#players-grid");
    this.nodes.drawCard = this.root.querySelector("#draw-card");
    this.nodes.discardCard = this.root.querySelector("#discard-card");
    this.nodes.pileMeta = this.root.querySelector("#pile-meta");
    this.nodes.directionPill = this.root.querySelector("#direction-pill");
    this.nodes.feedbackText = this.root.querySelector("#feedback-text");
    this.nodes.scoreboardModal = this.root.querySelector("#scoreboard-modal");
    this.nodes.settingsModal = this.root.querySelector("#settings-modal");
    this.nodes.wildModal = this.root.querySelector("#wild-modal");
    this.nodes.winOverlay = this.root.querySelector("#win-overlay");
    this.nodes.toast = this.root.querySelector("#toast-alert");
  }

  bindLandingEvents() {
    this.root.querySelector("#start-game-btn")?.addEventListener("click", () => {
      this.gameEngine.setScreen("setup");
    });
  }

  bindSetupEvents() {
    this.root.querySelector("#back-to-landing")?.addEventListener("click", () => {
      this.gameEngine.setScreen("landing");
    });

    this.nodes.playerCount?.addEventListener("change", (e) => {
      if (this.nodes.playerCount?.disabled) return;
      const selectedPlayers = Number(e.target.value);
      const oldNames = this.stateManager.getState().setup.playerNames;
      const playerNames = Array.from({ length: selectedPlayers }, (_, i) => oldNames[i] || "");
      this.gameEngine.updateSetup({ selectedPlayers, playerNames });
    });

    this.root.querySelector("#mode-local")?.addEventListener("click", () => {
      this.gameEngine.updateSetup({ mode: "local" });
      this.updateSetupModeButtons();
    });

    this.root.querySelector("#mode-online")?.addEventListener("click", () => {
      const setup = this.stateManager.getState().setup;
      const nextPlayers = Math.max(2, setup.selectedPlayers);
      this.gameEngine.updateSetup({
        mode: "online",
        selectedPlayers: nextPlayers,
        playerNames: Array.from({ length: nextPlayers }, (_, i) => setup.playerNames[i] || ""),
      });
      this.updateSetupModeButtons();
      this.updateSetupOnlinePanel();
    });

    this.nodes.onlinePanel?.addEventListener("click", async (event) => {
      const action = event.target.closest("[data-online-action]")?.dataset.onlineAction;
      if (!action) return;

      this.nodes.error.textContent = "";
      const setup = this.stateManager.getState().setup;
      const online = setup.online;
      const localName = (online.localDisplayName || setup.playerNames[0] || "").trim();

      if (action === "auth-google") {
        const result = await this.authManager.signInWithGoogle();
        if (!result.ok) this.nodes.error.textContent = result.error;
        return;
      }

      if (action === "auth-apple") {
        const result = await this.authManager.signInWithApple();
        if (!result.ok) this.nodes.error.textContent = result.error;
        return;
      }

      if (action === "auth-logout") {
        const result = await this.authManager.signOut();
        if (!result.ok) this.nodes.error.textContent = result.error;
        return;
      }

      if (action === "create-room") {
        const result = await this.onlineEngine.createRoom({
          displayName: localName,
          expectedPlayers: setup.selectedPlayers,
        });
        if (!result.ok) this.nodes.error.textContent = result.error;
        return;
      }

      if (action === "join-room") {
        const code = this.root.querySelector("#room-code-input")?.value || "";
        const result = await this.onlineEngine.joinRoom({ roomCode: code, displayName: localName });
        if (!result.ok) this.nodes.error.textContent = result.error;
        return;
      }

      if (action === "copy-room") {
        if (!online.roomCode) return;
        await navigator.clipboard.writeText(online.roomCode);
        this.showToast(`Copied room code: ${online.roomCode}`);
        return;
      }

      if (action === "copy-invite-link") {
        if (!online.inviteUrl) return;
        await navigator.clipboard.writeText(online.inviteUrl);
        this.showToast("Invite link copied.");
        return;
      }

      if (action === "share-invite-link") {
        if (!online.inviteUrl) return;
        try {
          if (navigator.share) {
            await navigator.share({
              title: "Join my UNO room",
              text: "Tap to join my UNO room.",
              url: online.inviteUrl,
            });
          } else {
            await navigator.clipboard.writeText(online.inviteUrl);
            this.showToast("Invite link copied.");
          }
        } catch (err) {
          if (err?.name !== "AbortError") {
            this.showToast("Could not open share sheet.");
          }
        }
      }
    });

    this.root.querySelector("#start-match")?.addEventListener("click", async () => {
      const state = this.stateManager.getState();
      if (state.setup.mode === "online") {
        const result = await this.onlineEngine.startOnlineMatch();
        if (!result.ok) this.nodes.error.textContent = result.error;
        return;
      }
      const result = this.gameEngine.startGame({
        playerNames: state.setup.playerNames,
        selectedPlayers: state.setup.selectedPlayers,
        mode: state.setup.mode,
      });

      if (!result.ok) {
        this.nodes.error.textContent = result.error;
      }
    });
  }

  updateSetupModeButtons() {
    const mode = this.stateManager.getState().setup.mode;
    this.root.querySelector("#mode-local")?.classList.toggle("active", mode === "local");
    this.root.querySelector("#mode-online")?.classList.toggle("active", mode === "online");
  }

  updateSetupFields() {
    if (!this.nodes.nameFields) return;
    const setup = this.stateManager.getState().setup;
    const online = setup.online;
    const onlineLocked = setup.mode === "online"
      && !!(online.roomId || online.roomCode || online.pendingInviteCode);
    const lockedPlayers = online.expectedPlayers || setup.selectedPlayers;
    const joinedCount = online.lobbyPlayers?.length || 0;
    const remaining = Math.max(lockedPlayers - joinedCount, 0);

    this.nodes.playerCount.value = String(setup.selectedPlayers);
    this.nodes.playerCount.disabled = onlineLocked;
    this.nodes.playerCountLabel.classList.toggle("hidden", onlineLocked);
    this.nodes.playerCountLocked.classList.toggle("hidden", !onlineLocked);
    if (onlineLocked) {
      this.nodes.playerCountLocked.textContent = `Players (locked): ${lockedPlayers}`;
    }
    this.nodes.note.textContent = setup.selectedPlayers === 1
      ? "Solo mode detected: one AI opponent will be added automatically."
      : setup.mode === "online"
        ? "Online mode: host picks player count, invite friends, and the match auto-starts when lobby is full."
        : "Local pass-and-play enabled.";

    if (this.lastSetupCount !== setup.selectedPlayers) {
      this.nodes.nameFields.innerHTML = setup.playerNames.map((name, idx) => `
        <label class="name-field">
          Player ${idx + 1} Name
          <input data-name-index="${idx}" value="${name}" class="input" maxlength="16" placeholder="Enter Player ${idx + 1} Name" />
        </label>
      `).join("");

      this.nodes.nameFields.querySelectorAll("input[data-name-index]").forEach((input) => {
        input.addEventListener("input", (event) => {
          const index = Number(event.target.dataset.nameIndex);
          const next = [...this.stateManager.getState().setup.playerNames];
          next[index] = event.target.value;
          this.gameEngine.updateSetup({ playerNames: next });
        });
      });
      this.lastSetupCount = setup.selectedPlayers;
    } else {
      this.nodes.nameFields.querySelectorAll("input[data-name-index]").forEach((input) => {
        const index = Number(input.dataset.nameIndex);
        const nextValue = setup.playerNames[index] || "";
        if (document.activeElement !== input && input.value !== nextValue) {
          input.value = nextValue;
        }
      });
    }

    this.updateSetupModeButtons();
    this.updateSetupOnlinePanel();

    const startBtn = this.root.querySelector("#start-match");
    if (setup.mode === "online") {
      if (!online.roomId) {
        startBtn.textContent = "Create or Join Room";
        startBtn.disabled = true;
      } else if (online.status === "active") {
        startBtn.textContent = "Match In Progress";
        startBtn.disabled = true;
      } else if (online.status === "waiting" && online.isHost && remaining === 0) {
        startBtn.textContent = "Starting game...";
        startBtn.disabled = true;
      } else if (online.status === "waiting" && online.isHost) {
        startBtn.textContent = `Waiting for players (${joinedCount}/${lockedPlayers})`;
        startBtn.disabled = true;
      } else if (online.status === "waiting") {
        startBtn.textContent = `Waiting for host (${joinedCount}/${lockedPlayers})`;
        startBtn.disabled = true;
      } else {
        startBtn.textContent = "Start Online Match";
        startBtn.disabled = true;
      }
    } else {
      startBtn.textContent = "Start Match";
      startBtn.disabled = false;
    }
  }

  updateSetupOnlinePanel() {
    if (!this.nodes.onlinePanel) return;
    const state = this.stateManager.getState();
    const setup = state.setup;
    const auth = state.auth;
    const online = setup.online;
    const isOnline = setup.mode === "online";

    this.nodes.onlinePanel.classList.toggle("hidden", !isOnline);
    if (!isOnline) return;

    const lobbyPlayers = online.lobbyPlayers || [];
    const lobbyRows = lobbyPlayers.length
      ? lobbyPlayers.map((p) => `<li><span>${p.player_index + 1}.</span> ${p.display_name}</li>`).join("")
      : "<li>No players joined yet.</li>";
    const pendingInviteNotice = online.pendingInviteCode
      ? `<p class="small-text invite-notice">Invite detected for room <strong>${online.pendingInviteCode}</strong>. Sign in to auto-join.</p>`
      : "";
    const pendingInviteError = online.pendingInviteError
      ? `<p class="small-text invite-error">${online.pendingInviteError}</p>`
      : "";
    const inviteSection = online.roomCode
      ? `
          <div class="invite-box">
            <p class="small-text">Invite Token: <code>${online.inviteToken}</code></p>
            <input class="input invite-url-input" value="${online.inviteUrl}" readonly />
            <div class="invite-actions">
              <button class="btn ghost" data-online-action="copy-invite-link">Copy Invite Link</button>
              <button class="btn ghost" data-online-action="share-invite-link">Share Invite Link</button>
            </div>
          </div>
        `
      : "";
    const expectedPlayers = online.expectedPlayers || setup.selectedPlayers;
    const joinedCount = lobbyPlayers.length;
    const waitingFor = Math.max(expectedPlayers - joinedCount, 0);
    const waitingCopy = online.status === "active"
      ? "Match started."
      : waitingFor === 0
        ? (online.isHost ? "Starting game..." : "Waiting for host to start...")
        : `Waiting for ${waitingFor} more player${waitingFor === 1 ? "" : "s"}...`;
    const roomControls = online.roomId
      ? `<p class="small-text">Connected to room. Share invite link or wait in lobby.</p>`
      : `
          <div class="online-controls">
            <button class="btn" data-online-action="create-room" ${!auth.user ? "disabled" : ""}>Create Room</button>
            <input id="room-code-input" class="input room-code-input" placeholder="Room code" value="${online.pendingInviteCode || online.roomCode || ""}" ${!auth.user ? "disabled" : ""} />
            <button class="btn" data-online-action="join-room" ${!auth.user ? "disabled" : ""}>Join Room</button>
          </div>
        `;

    this.nodes.onlinePanel.innerHTML = `
      <div class="online-card">
        <h3>Online Lobby</h3>
        <p class="small-text">Status: ${online.status || "offline"} ${online.loading ? "(loading...)" : ""}</p>
        <p class="small-text">Players Joined: ${joinedCount} / ${expectedPlayers}</p>
        <p class="small-text">${waitingCopy}</p>
        ${pendingInviteNotice}
        ${pendingInviteError}
        ${
          !auth.enabled
            ? "<p class='small-text'>Supabase keys missing. Set Vercel env vars first.</p>"
            : auth.user
              ? `<p class='small-text'>Signed in as <strong>${auth.user.email || auth.user.id}</strong></p>
                 <button class='btn ghost' data-online-action='auth-logout'>Sign Out</button>`
              : `<div class="auth-provider-row">
                   <button class='btn primary' data-online-action='auth-google'>Sign in with Google</button>
                   <button class='btn ghost' data-online-action='auth-apple'>Sign in with Apple</button>
                 </div>`
        }
        ${roomControls}

        <div class="online-room-meta">
          <p class="small-text">Room: <strong>${online.roomCode || "-"}</strong></p>
          <button class="btn ghost" data-online-action="copy-room" ${!online.roomCode ? "disabled" : ""}>Copy Code</button>
          <p class="small-text">Host: ${online.isHost ? "You" : "Another player"}</p>
          <p class="small-text">Players: ${joinedCount}/${expectedPlayers}</p>
        </div>
        ${inviteSection}

        <ul class="lobby-list">${lobbyRows}</ul>
      </div>
    `;
  }

  bindGameEvents() {
    this.root.querySelector("#open-scoreboard")?.addEventListener("click", () => {
      this.gameEngine.openScoreboard(true);
      this.updateScoreboardTable();
    });

    this.root.querySelector("#open-settings")?.addEventListener("click", () => {
      this.gameEngine.openSettings(true);
    });

    this.root.querySelector("#leave-game")?.addEventListener("click", () => {
      this.leaveGameFlow();
    });

    this.nodes.drawCard?.addEventListener("click", () => {
      const game = this.stateManager.getState().game;
      if (!game || game.winnerId) return;
      const player = game.players[game.currentTurn];
      if (player.isAI) return;
      if (!this.canLocalUserAct(player, game)) return;

      if (game.mode === "online") {
        this.onlineEngine.requestDraw({ playerId: player.id });
      } else {
        this.gameEngine.drawCard(player.id, { passTurn: true });
      }
    });

    this.nodes.playersGrid?.addEventListener("click", (event) => {
      const cardNode = event.target.closest("[data-card-id]");
      if (!cardNode) return;

      const game = this.stateManager.getState().game;
      if (!game || game.winnerId) return;

      const player = game.players[game.currentTurn];
      if (player.isAI) return;
      if (!this.canLocalUserAct(player, game)) return;

      const cardId = cardNode.dataset.cardId;
      const card = player.hand.find((item) => item.id === cardId);
      if (!card) return;

      if (!this.gameEngine.isPlayable(card, game)) {
        this.showToast("That card cannot be played now.");
        return;
      }

      if (card.type === "wild") {
        this.pendingWild = { playerId: player.id, cardId };
        this.openWildModal();
        return;
      }

      this.animationEngine.flyCardToDiscard(cardNode, this.nodes.discardCard);
      if (game.mode === "online") {
        this.onlineEngine.requestPlay({ playerId: player.id, cardId });
      } else {
        this.gameEngine.playCard({ playerId: player.id, cardId });
      }
    });

    this.nodes.wildModal?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-wild-color]");
      if (!button || !this.pendingWild) return;

      const { playerId, cardId } = this.pendingWild;
      this.pendingWild = null;
      this.closeWildModal();
      const game = this.stateManager.getState().game;
      if (game?.mode === "online") {
        this.onlineEngine.requestPlay({
          playerId,
          cardId,
          declaredColor: button.dataset.wildColor,
        });
      } else {
        this.gameEngine.playCard({
          playerId,
          cardId,
          declaredColor: button.dataset.wildColor,
        });
      }
    });

    this.nodes.scoreboardModal?.addEventListener("click", (event) => {
      if (event.target.matches(".modal-close") || event.target.classList.contains("modal")) {
        this.gameEngine.openScoreboard(false);
      }
    });

    this.nodes.settingsModal?.addEventListener("click", async (event) => {
      if (event.target.matches(".modal-close") || event.target.classList.contains("modal")) {
        this.gameEngine.openSettings(false);
        return;
      }

      if (event.target.matches("#sound-toggle")) {
        const enabled = event.target.dataset.enabled !== "true";
        this.soundManager.setEnabled(enabled);
        event.target.dataset.enabled = String(enabled);
        event.target.textContent = enabled ? "Sound: On" : "Sound: Off";
      }

      if (event.target.matches("#leave-from-settings")) {
        this.leaveGameFlow();
        return;
      }

      if (event.target.matches("#signout-from-settings")) {
        await this.authManager.signOut();
        await this.leaveGameFlow();
        this.gameEngine.setScreen("setup");
        this.showToast("Signed out.");
      }
    });
  }

  updateGame() {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game || !this.nodes.playersGrid) return;

    this.nodes.directionPill.textContent = `Direction: ${game.direction === 1 ? "Clockwise" : "Counterclockwise"}`;
    this.nodes.pileMeta.textContent = `Deck: ${game.drawPile.length}`;

    const top = game.discardPile[game.discardPile.length - 1];
    this.nodes.discardCard.className = `uno-card discard-card ${top.selectedColor || top.color}`;
    this.nodes.discardCard.innerHTML = this.cardInner(top, true);

    const current = game.players[game.currentTurn];
    this.nodes.drawCard.disabled = !!game.winnerId || current.isAI || !this.canLocalUserAct(current, game);

    this.nodes.playersGrid.innerHTML = game.players
      .map((player, index) => this.renderPlayerPanel(player, index, game))
      .join("");

    if (game.winnerId) {
      const winner = game.players.find((p) => p.id === game.winnerId);
      this.showWinOverlay(winner?.name || "Unknown");
    } else {
      this.hideWinOverlay();
    }

    this.updateOverlays();
  }

  renderPlayerPanel(player, index, game) {
    const isActive = index === game.currentTurn;
    const localUserId = this.stateManager.getState().auth.user?.id;
    const isLocalPlayer = game.mode === "online"
      ? !!localUserId && player.userId === localUserId
      : isActive;
    const canShowCards = isLocalPlayer && !player.isAI && !game.winnerId;
    const cards = canShowCards
      ? player.hand.map((card, cardIndex) => {
          const playable = isActive && this.canLocalUserAct(player, game) && this.gameEngine.isPlayable(card, game);
          const mid = (player.hand.length - 1) / 2;
          const fanAngle = `${(cardIndex - mid) * 4}deg`;
          const fanLift = `${Math.abs(cardIndex - mid) * -1.2}px`;
          return `
            <button
              class="uno-card hand-card ${card.selectedColor || card.color} ${playable ? "playable" : "disabled"}"
              data-card-id="${card.id}"
              style="--card-index:${cardIndex}; --card-count:${player.hand.length}; --fan-angle:${fanAngle}; --fan-lift:${fanLift};"
            >
              ${this.cardInner(card)}
            </button>
          `;
        }).join("")
      : Array.from({ length: player.hand.length }, () => `<div class="card-back"></div>`).join("");

    return `
      <article class="player-panel ${isActive ? "active" : ""} ${player.oneCardWarning ? "danger" : ""}">
        <header>
          <h3>${player.name} ${player.isAI ? "<span class=\"tag\">AI</span>" : ""}</h3>
          <span>${player.hand.length} cards</span>
        </header>
        <div class="hand-zone ${canShowCards ? "revealed" : "hidden-hand"}">
          ${cards}
        </div>
      </article>
    `;
  }

  cardInner(card, compact = false) {
    const number = cardText(card);
    if (card.type === "wild") {
      return `
        <span class="corner top">${number}</span>
        <span class="center">${number}</span>
        <span class="corner bottom">${number}</span>
        ${compact ? "" : "<span class=\"gloss\"></span>"}
      `;
    }

    return `
      <span class="corner top">${number}</span>
      <span class="center">${number}</span>
      <span class="corner bottom">${number}</span>
      ${compact ? "" : "<span class=\"gloss\"></span>"}
    `;
  }

  handleFeedback(payload) {
    if (!payload) return;
    this.nodes.feedbackText.textContent = payload.text;

    const discardRect = this.nodes.discardCard?.getBoundingClientRect();
    if (!discardRect) return;
    const x = discardRect.left + discardRect.width / 2;
    const y = discardRect.top + discardRect.height / 2;

    const top = this.stateManager.getState().game?.discardPile?.slice(-1)[0];
    const color = this.cssColorFor(top?.selectedColor || top?.color);

    if (payload.action === "draw") {
      this.particleEngine.emitSkipPulse(x, y);
      return;
    }

    this.particleEngine.emitCardBurst(x, y, color);

    if (payload.action === "reverse") {
      this.particleEngine.emitReverseTrail(x, y);
    }

    if (payload.action === "skip") {
      this.particleEngine.emitSkipPulse(x, y);
    }

    if (payload.action === "wild" || payload.action === "wild4") {
      this.particleEngine.emitWildExplosion(x, y);
    }

    if (payload.action === "win") {
      this.animationEngine.shakeScreen(document.body);
      this.particleEngine.emitConfettiFullScreen();
    }
  }

  handleTurn(payload) {
    if (!payload || !this.nodes.turnBanner) return;
    this.nodes.turnBanner.textContent = `Turn: ${payload.playerName}`;
    this.animationEngine.zoomTurnBanner(this.nodes.turnBanner);

    const game = this.stateManager.getState().game;
    const localUserId = this.stateManager.getState().auth.user?.id;
    const isLocalTurn = game?.mode === "online"
      ? !!localUserId && payload.userId === localUserId
      : !payload.isAI;

    if (isLocalTurn) {
      this.showToast(`Alert: ${payload.playerName}, it's your turn.`);
    }
  }

  openWildModal() {
    this.nodes.wildModal.classList.remove("hidden");
    this.nodes.wildModal.innerHTML = `
      <div class="modal-card">
        <h3>Choose Wild Color</h3>
        <div class="wild-grid">
          ${COLOR_ORDER.map((color) => `<button class="btn ${color}" data-wild-color="${color}">${color.toUpperCase()}</button>`).join("")}
        </div>
      </div>
    `;
  }

  closeWildModal() {
    this.nodes.wildModal.classList.add("hidden");
  }

  showWinOverlay(name) {
    if (!this.nodes.winOverlay) return;
    this.nodes.winOverlay.classList.remove("hidden");
    this.nodes.winOverlay.innerHTML = `
      <div class="win-content">
        <h2>🏆 ${name} WINS!</h2>
        <p>Match complete. Open Scoreboard to view updated stats.</p>
      </div>
    `;
    this.particleEngine.emitConfettiFullScreen();
    this.animationEngine.shakeScreen(document.body);
  }

  hideWinOverlay() {
    this.nodes.winOverlay?.classList.add("hidden");
  }

  updateOverlays() {
    const state = this.stateManager.getState();
    if (!this.nodes.scoreboardModal || !this.nodes.settingsModal) return;

    if (state.ui.scoreboardOpen) {
      this.nodes.scoreboardModal.classList.remove("hidden");
      this.updateScoreboardTable();
    } else {
      this.nodes.scoreboardModal.classList.add("hidden");
    }

    if (state.ui.settingsOpen) {
      const signedIn = !!state.auth.user;
      this.nodes.settingsModal.classList.remove("hidden");
      this.nodes.settingsModal.innerHTML = `
        <div class="modal-card">
          <button class="modal-close">Close</button>
          <h3>Settings</h3>
          <button id="sound-toggle" class="btn" data-enabled="${this.soundManager.enabled}">
            ${this.soundManager.enabled ? "Sound: On" : "Sound: Off"}
          </button>
          ${signedIn ? "<button id=\"signout-from-settings\" class=\"btn ghost\">Log Out</button>" : ""}
          <button id="leave-from-settings" class="btn danger">Leave Game</button>
        </div>
      `;
    } else {
      this.nodes.settingsModal.classList.add("hidden");
    }
  }

  updateScoreboardTable() {
    if (!this.nodes.scoreboardModal || this.nodes.scoreboardModal.classList.contains("hidden")) return;

    const leaderboard = this.statsManager.getLeaderboard();
    const rows = leaderboard.length
      ? leaderboard.map((item, index) => `
        <tr class="${index === 0 ? "leader" : ""}">
          <td>${index === 0 ? "🏆" : index + 1}</td>
          <td>${item.name}</td>
          <td>${item.gamesPlayed}</td>
          <td>${item.gamesWon}</td>
          <td>${item.winPct}%</td>
          <td>${item.totalCardsPlayed}</td>
          <td>${item.totalWildCardsUsed}</td>
        </tr>
      `).join("")
      : `<tr><td colspan="7">No games played yet.</td></tr>`;

    this.nodes.scoreboardModal.innerHTML = `
      <div class="modal-card wide">
        <button class="modal-close">Close</button>
        <h3>Scoreboard</h3>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Games</th>
                <th>Wins</th>
                <th>Win %</th>
                <th>Cards Played</th>
                <th>Wilds Used</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  canLocalUserAct(player, game) {
    if (!player || !game) return false;
    if (game.mode !== "online") return true;
    const localUserId = this.stateManager.getState().auth.user?.id;
    return !!localUserId && localUserId === player.userId;
  }

  async leaveGameFlow() {
    const game = this.stateManager.getState().game;
    if (game?.mode === "online") {
      await this.onlineEngine.teardownRoom();
      this.gameEngine.updateSetup({
        online: {
          ...this.stateManager.getState().setup.online,
          status: "offline",
          lobbyPlayers: [],
          roomId: null,
          roomCode: "",
          inviteToken: "",
          inviteUrl: "",
          isHost: false,
        },
      });
    }
    this.gameEngine.leaveGame();
  }

  cssColorFor(color) {
    const map = {
      red: "#f94144",
      yellow: "#f9c74f",
      green: "#43aa8b",
      blue: "#577590",
      wild: "#ffffff",
    };
    return map[color] || "#ffffff";
  }

  showToast(text) {
    if (!this.nodes.toast) return;
    this.nodes.toast.textContent = text;
    this.nodes.toast.classList.add("show");
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => {
      this.nodes.toast.classList.remove("show");
    }, 1600);
  }
}
