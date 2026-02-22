const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomRoomCode(length = 6) {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function encodeInviteToken(roomCode) {
  try {
    return btoa(roomCode)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  } catch {
    return "";
  }
}

function decodeInviteToken(token) {
  try {
    const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = atob(padded);
    return decoded.trim().toUpperCase();
  } catch {
    return "";
  }
}

function displayNameFromUser(user) {
  const meta = user?.user_metadata || {};
  return (
    meta.full_name ||
    meta.name ||
    (user?.email ? user.email.split("@")[0] : "") ||
    "Player"
  );
}

export class OnlineEngine {
  constructor({ eventBus, stateManager, gameEngine, authManager }) {
    this.eventBus = eventBus;
    this.stateManager = stateManager;
    this.gameEngine = gameEngine;
    this.authManager = authManager;

    this.supabase = null;
    this.channel = null;
    this.activeRoom = null;
    this.localBroadcastRef = `ref_${Math.random().toString(36).slice(2, 10)}`;
    this.autoStartInFlight = false;
    this.pullRoomStateInFlight = false;
    this.pullRoomStatePromise = null;
    this.pullRoomStateQueued = false;
    this.pullRoomStateQueuedRoomId = null;
    this.uiStatusTimer = null;
    this.roomSyncIntervalId = null;

    this.eventBus.on("auth:changed", async () => {
      await this.refreshLobby();
      await this.tryAutoJoinFromInvite();
    });
  }

  setClient(supabase) {
    this.supabase = supabase;
    this.patchSetup({ enabled: !!supabase });
  }

  getRoomVersion() {
    const activeVersion = Number(this.activeRoom?.version ?? 0);
    return Math.max(activeVersion, this.getLastSeenVersion());
  }

  getLastSeenVersion() {
    return Number(this.stateManager.getState().setup.online.lastSeenVersion || 0);
  }

  syncLastSeenVersion(version) {
    const next = Number(version);
    if (!Number.isFinite(next)) return;
    const current = this.getLastSeenVersion();
    if (next <= current) return;
    this.patchSetup({ lastSeenVersion: next });
  }

  hydratePlayerUserIdsFromLobby(game) {
    if (!game || !Array.isArray(game.players)) return;
    const lobbyPlayers = this.stateManager.getState().setup.online.lobbyPlayers || [];
    if (!Array.isArray(lobbyPlayers) || lobbyPlayers.length === 0) return;

    const byIndex = new Map();
    lobbyPlayers.forEach((entry) => {
      const index = Number(entry.player_index);
      if (Number.isInteger(index) && index >= 0) {
        byIndex.set(index, entry);
      }
    });

    game.players.forEach((player, index) => {
      if (player.userId) return;
      const lobby = byIndex.get(index);
      if (lobby?.user_id) {
        player.userId = lobby.user_id;
      }
    });
  }

  resolveLocalSeatFromLobby(
    game,
    { userId = null, allowDisplayNameFallback = true } = {},
  ) {
    if (!game || !Array.isArray(game.players) || game.players.length === 0) return null;

    const online = this.stateManager.getState().setup.online;
    const lobbyPlayers = Array.isArray(online.lobbyPlayers) ? online.lobbyPlayers : [];
    if (lobbyPlayers.length > 0) {
      if (userId) {
        const lobbyMatch = lobbyPlayers.find((entry) => entry.user_id === userId);
        const lobbyIndex = Number(lobbyMatch?.player_index);
        if (Number.isInteger(lobbyIndex) && lobbyIndex >= 0 && game.players[lobbyIndex]) {
          return { index: lobbyIndex, id: game.players[lobbyIndex].id };
        }
      }

      if (allowDisplayNameFallback) {
        const displayName = (online.localDisplayName || "").trim().toLowerCase();
        if (displayName) {
          const lobbyByName = lobbyPlayers.find((entry) =>
            (entry.display_name || "").trim().toLowerCase() === displayName
          );
          const lobbyIndex = Number(lobbyByName?.player_index);
          if (Number.isInteger(lobbyIndex) && lobbyIndex >= 0 && game.players[lobbyIndex]) {
            return { index: lobbyIndex, id: game.players[lobbyIndex].id };
          }
        }
      }
    }

    return null;
  }

  syncLocalSeatFromGame(game) {
    if (!game || game.mode !== "online") {
      this.patchSetup({ localPlayerId: null, localPlayerIndex: null });
      return;
    }

    this.hydratePlayerUserIdsFromLobby(game);

    const localUserId = this.authManager.getUser()?.id;
    if (!localUserId) {
      this.patchSetup({ localPlayerId: null, localPlayerIndex: null });
      return;
    }

    let localPlayerIndex = game.players.findIndex((player) => player.userId === localUserId);
    let localPlayerId = localPlayerIndex >= 0 ? game.players[localPlayerIndex].id : null;

    if (localPlayerIndex < 0) {
      const fallback = this.resolveLocalSeatFromLobby(game, { userId: localUserId });
      if (fallback) {
        localPlayerIndex = fallback.index;
        localPlayerId = fallback.id;
      }
    }

    this.patchSetup({
      localPlayerId,
      localPlayerIndex: localPlayerIndex >= 0 ? localPlayerIndex : null,
    });

    console.log("[ONLINE][seat]", {
      roomId: this.activeRoom?.id || this.stateManager.getState().setup.online.roomId || null,
      version: this.getRoomVersion(),
      localPlayerId,
      localPlayerIndex: localPlayerIndex >= 0 ? localPlayerIndex : null,
      currentTurn: game.currentTurn,
    });
  }

  startRoomSyncLoop(roomId) {
    this.stopRoomSyncLoop();
    if (!roomId) return;

    this.roomSyncIntervalId = setInterval(async () => {
      const online = this.stateManager.getState().setup.online;
      if (!this.activeRoom || this.activeRoom.id !== roomId) return;
      if (online.status !== "active") return;
      await this.pullRoomState(roomId);
    }, 1800);
  }

  stopRoomSyncLoop() {
    if (this.roomSyncIntervalId) {
      clearInterval(this.roomSyncIntervalId);
      this.roomSyncIntervalId = null;
    }
  }

  patchSetup(patch) {
    const current = this.stateManager.getState().setup.online;
    const merged = { ...current, ...patch };

    if (merged.roomCode) {
      const token = encodeInviteToken(merged.roomCode);
      const inviteUrl = `${window.location.origin}?invite=${encodeURIComponent(token)}`;
      merged.inviteToken = token;
      merged.inviteUrl = inviteUrl;
    } else {
      merged.inviteToken = "";
      merged.inviteUrl = "";
    }

    this.gameEngine.updateSetup({
      online: merged,
    });
  }

  setTransientUiStatus(message, durationMs = 900) {
    if (this.uiStatusTimer) {
      clearTimeout(this.uiStatusTimer);
      this.uiStatusTimer = null;
    }

    this.patchSetup({ uiStatus: message });
    if (!durationMs || durationMs <= 0) return;

    this.uiStatusTimer = setTimeout(() => {
      this.uiStatusTimer = null;
      const online = this.stateManager.getState().setup.online;
      if (online.uiStatus === message) {
        this.patchSetup({ uiStatus: null });
      }
    }, durationMs);
  }

  syncSetupForExpectedPlayers(expectedPlayers) {
    const setup = this.stateManager.getState().setup;
    const n = Number(expectedPlayers);
    const safeExpected = Number.isFinite(n)
      ? Math.max(2, Math.min(5, n))
      : Math.max(2, Math.min(5, setup.selectedPlayers));

    const nextNames = Array.from({ length: safeExpected }, (_, i) => setup.playerNames[i] || "");
    const shouldUpdate = setup.selectedPlayers !== safeExpected || setup.playerNames.length !== safeExpected;

    if (shouldUpdate) {
      this.gameEngine.updateSetup({
        selectedPlayers: safeExpected,
        playerNames: nextNames,
      });
    }
  }

  hydrateInviteFromUrl() {
    const url = new URL(window.location.href);
    const inviteToken = (url.searchParams.get("invite") || "").trim();
    const inviteCodeRaw = (url.searchParams.get("room") || "").trim().toUpperCase();
    const inviteCode = inviteCodeRaw || decodeInviteToken(inviteToken);

    if (!inviteCode) return;

    const state = this.stateManager.getState();
    const setup = state.setup;
    const nextPlayers = Math.max(2, setup.selectedPlayers);

    this.gameEngine.updateSetup({
      mode: "online",
      selectedPlayers: nextPlayers,
      playerNames: Array.from({ length: nextPlayers }, (_, i) => setup.playerNames[i] || ""),
      online: {
        ...setup.online,
        pendingInviteCode: inviteCode,
        pendingInviteToken: inviteToken || encodeInviteToken(inviteCode),
      },
    });
    this.gameEngine.setScreen("setup");
  }

  async tryAutoJoinFromInvite() {
    const state = this.stateManager.getState();
    const online = state.setup.online;
    const user = this.authManager.getUser();

    if (!this.supabase || !user) return;
    if (!online.pendingInviteCode) return;
    if (online.roomId || online.loading) return;

    const preferred = (online.localDisplayName || displayNameFromUser(user)).trim();
    if (!preferred) return;

    this.patchSetup({ localDisplayName: preferred });
    const code = online.pendingInviteCode;
    const result = online.pendingInviteToken
      ? await this.joinRoomByInviteToken({
          inviteToken: online.pendingInviteToken,
          displayName: preferred,
        })
      : await this.joinRoom({ roomCode: code, displayName: preferred });

    if (result.ok) {
      this.patchSetup({ pendingInviteCode: "", pendingInviteToken: "" });
      this.clearInviteParamsFromLocation();
      this.eventBus.emit("online:autojoined", { roomCode: code });
    } else {
      this.patchSetup({ pendingInviteError: result.error || "Invite join failed." });
      this.eventBus.emit("online:autojoin-failed", { error: result.error || "Invite join failed." });
    }
  }

  async joinRoomByInviteToken({ inviteToken, displayName }) {
    const roomCode = decodeInviteToken((inviteToken || "").trim());
    if (!roomCode) {
      return { ok: false, error: "Invalid invite token." };
    }
    return this.joinRoom({ roomCode, displayName });
  }

  clearInviteParamsFromLocation() {
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    url.searchParams.delete("room");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async createRoom({ displayName, expectedPlayers }) {
    const user = this.authManager.getUser();
    if (!this.supabase || !user) return { ok: false, error: "Sign in first." };

    const safeName = ((displayName || "").trim() || displayNameFromUser(user)).trim();
    if (!safeName) return { ok: false, error: "Enter your name before creating a room." };

    this.patchSetup({ loading: true, error: null });

    let room = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = randomRoomCode(6);
      const { data, error } = await this.supabase
        .from("game_rooms")
        .insert({
          code,
          host_user_id: user.id,
          expected_players: expectedPlayers,
          status: "waiting",
          version: 0,
        })
        .select("id, code, host_user_id, expected_players, status, version")
        .single();

      if (!error && data) {
        room = data;
        break;
      }
    }

    if (!room) {
      this.patchSetup({ loading: false, error: "Could not create room. Try again." });
      return { ok: false, error: "Could not create room." };
    }

    const { error: playerError } = await this.supabase
      .from("room_players")
      .insert({
        room_id: room.id,
        user_id: user.id,
        display_name: safeName,
        player_index: 0,
      });

    if (playerError) {
      this.patchSetup({ loading: false, error: playerError.message });
      return { ok: false, error: playerError.message };
    }

    this.patchSetup({
      roomCode: room.code,
      roomId: room.id,
      isHost: true,
      status: room.status,
      expectedPlayers: room.expected_players,
      localDisplayName: safeName,
      lastSeenVersion: room.version ?? 0,
      localPlayerId: null,
      localPlayerIndex: null,
    });

    try {
      await this.subscribeToRoom(room);
    } catch (error) {
      this.patchSetup({ loading: false, error: "Could not subscribe to room updates." });
      return { ok: false, error: "Could not subscribe to room updates." };
    }
    this.syncSetupForExpectedPlayers(room.expected_players);
    await this.refreshLobby();

    this.patchSetup({
      loading: false,
      error: null,
      roomCode: room.code,
      roomId: room.id,
      isHost: true,
      status: room.status,
      expectedPlayers: room.expected_players,
      localDisplayName: safeName,
      pendingInviteError: null,
      lastSeenVersion: room.version ?? this.getLastSeenVersion(),
    });

    return { ok: true, roomCode: room.code };
  }

  async joinRoom({ roomCode, displayName }) {
    const user = this.authManager.getUser();
    if (!this.supabase || !user) return { ok: false, error: "Sign in first." };

    const code = (roomCode || "").trim().toUpperCase();
    const safeName = ((displayName || "").trim() || displayNameFromUser(user)).trim();
    if (!code) return { ok: false, error: "Enter a room code." };
    if (!safeName) return { ok: false, error: "Enter your name first." };

    this.patchSetup({ loading: true, error: null });

    const { data: room, error: roomError } = await this.supabase
      .from("game_rooms")
      .select("id, code, host_user_id, expected_players, status, version")
      .eq("code", code)
      .single();

    if (roomError || !room) {
      this.patchSetup({ loading: false, error: "Room not found." });
      return { ok: false, error: "Room not found." };
    }

    if (room.status === "finished") {
      this.patchSetup({ loading: false, error: "Room has already finished." });
      return { ok: false, error: "Room finished." };
    }

    this.syncSetupForExpectedPlayers(room.expected_players);
    const setup = this.stateManager.getState().setup;
    this.gameEngine.updateSetup({
      mode: "online",
      selectedPlayers: room.expected_players,
      playerNames: Array.from({ length: room.expected_players }, (_, i) => setup.playerNames[i] || ""),
    });
    this.patchSetup({
      roomCode: room.code,
      roomId: room.id,
      isHost: room.host_user_id === user.id,
      status: room.status,
      expectedPlayers: room.expected_players,
      localDisplayName: safeName,
      lastSeenVersion: room.version ?? 0,
      localPlayerId: null,
      localPlayerIndex: null,
    });

    const { data: players } = await this.supabase
      .from("room_players")
      .select("id, user_id, player_index")
      .eq("room_id", room.id)
      .order("player_index", { ascending: true });

    const existing = (players || []).find((p) => p.user_id === user.id);
    if (!existing) {
      if ((players || []).length >= room.expected_players) {
        this.patchSetup({ loading: false, error: "Room is full." });
        return { ok: false, error: "Room is full." };
      }

      const takenSlots = new Set((players || []).map((p) => p.player_index));
      let slot = 0;
      while (takenSlots.has(slot)) slot += 1;

      const { error: insertError } = await this.supabase
        .from("room_players")
        .insert({
          room_id: room.id,
          user_id: user.id,
          display_name: safeName,
          player_index: slot,
        });

      if (insertError) {
        this.patchSetup({ loading: false, error: insertError.message });
        return { ok: false, error: insertError.message };
      }
    }

    try {
      await this.subscribeToRoom(room);
    } catch (error) {
      this.patchSetup({ loading: false, error: "Could not subscribe to room updates." });
      return { ok: false, error: "Could not subscribe to room updates." };
    }
    const snapshot = await this.refreshLobby();

    this.patchSetup({
      loading: false,
      error: null,
      roomCode: room.code,
      roomId: room.id,
      isHost: room.host_user_id === user.id,
      status: room.status,
      expectedPlayers: room.expected_players,
      localDisplayName: safeName,
      pendingInviteError: null,
      lastSeenVersion: room.version ?? this.getLastSeenVersion(),
    });

    if (snapshot?.room?.status !== "active") {
      this.setTransientUiStatus("Joined ✅ Waiting for host…", 800);
    } else {
      await this.pullRoomState(room.id);
    }

    return { ok: true };
  }

  async refreshLobby(options = {}) {
    const { checkAutoStart = true } = options;
    const { online } = this.stateManager.getState().setup;
    if (!this.supabase || !online.roomId) return;

    const { data: players } = await this.supabase
      .from("room_players")
      .select("id, room_id, user_id, display_name, player_index, joined_at")
      .eq("room_id", online.roomId)
      .order("player_index", { ascending: true });

    const { data: room } = await this.supabase
      .from("game_rooms")
      .select("status, expected_players, host_user_id, code, version")
      .eq("id", online.roomId)
      .single();

    const expectedPlayers = room?.expected_players || online.expectedPlayers;
    this.syncSetupForExpectedPlayers(expectedPlayers);
    if (Number.isFinite(Number(room?.version))) {
      this.syncLastSeenVersion(Number(room.version));
    }

    const user = this.authManager.getUser();
    if (this.activeRoom && room) {
      this.activeRoom.version = room.version ?? this.activeRoom.version ?? 0;
    }
    this.patchSetup({
      lobbyPlayers: players || [],
      status: room?.status || online.status,
      roomCode: room?.code || online.roomCode,
      expectedPlayers,
      isHost: user?.id ? room?.host_user_id === user.id : false,
    });

    console.log("[ONLINE][lobby]", {
      roomId: online.roomId,
      status: room?.status || online.status,
      version: room?.version ?? this.getRoomVersion(),
      joined: (players || []).length,
      expectedPlayers,
    });

    if (room?.status === "active") {
      const currentState = this.stateManager.getState();
      const currentGame = currentState.game;
      const alreadyInGame = currentState.screen === "game"
        && !!currentGame
        && currentGame.mode === "online"
        && (currentGame.roomCode === (room.code || online.roomCode));

      if (!alreadyInGame) {
        await this.pullRoomState(online.roomId);
      }
    }

    if (checkAutoStart) {
      await this.maybeAutoStart({
        room: room || null,
        players: players || [],
        expectedPlayers,
      });
    }

    return {
      room: room || null,
      players: players || [],
      expectedPlayers,
    };
  }

  async subscribeToRoom(room) {
    if (!this.supabase) return;

    await this.teardownRoom();
    this.activeRoom = room;
    this.activeRoom.version = room.version ?? this.activeRoom.version ?? 0;
    this.syncLastSeenVersion(this.activeRoom.version);
    console.log("[ONLINE][subscribe]", { roomId: room.id, version: this.activeRoom.version });

    const channelName = `uno-room-${room.id}`;
    this.channel = this.supabase.channel(channelName);

    this.channel
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "game_rooms",
        filter: `id=eq.${room.id}`,
      }, (payload) => this.onRoomUpdated(payload.new))
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "room_players",
        filter: `room_id=eq.${room.id}`,
      }, async () => {
        const snapshot = await this.refreshLobby({ checkAutoStart: false });
        await this.maybeAutoStart({
          room: snapshot?.room || null,
          players: snapshot?.players || [],
          expectedPlayers: snapshot?.expectedPlayers || null,
        });
      })
      .on("broadcast", { event: "move_intent" }, (payload) => this.onMoveIntent(payload))
      .on("broadcast", { event: "intent_rejected" }, (payload) => this.onIntentRejected(payload))
      ;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const timeoutId = setTimeout(() => {
        finish(reject, new Error("Room subscription timed out."));
      }, 10000);

      this.channel.subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timeoutId);
          finish(resolve);
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timeoutId);
          finish(reject, new Error(err?.message || "Room subscription error."));
        }
      });
    });

    await this.pullRoomState(room.id);
    this.startRoomSyncLoop(room.id);
  }

  async teardownRoom() {
    if (this.channel && this.supabase) {
      await this.supabase.removeChannel(this.channel);
    }
    this.stopRoomSyncLoop();
    if (this.uiStatusTimer) {
      clearTimeout(this.uiStatusTimer);
      this.uiStatusTimer = null;
    }
    this.channel = null;
    this.activeRoom = null;
    this.patchSetup({
      localPlayerId: null,
      localPlayerIndex: null,
      lastSeenVersion: 0,
    });
  }

  async onRoomUpdated(room) {
    const incomingVersion = Number(room.version);
    const hasIncomingVersion = Number.isFinite(incomingVersion);
    const lastSeenVersion = this.getLastSeenVersion();

    if (hasIncomingVersion && incomingVersion < lastSeenVersion) {
      console.log("[ONLINE][update:ignored]", {
        roomId: room.id,
        incomingVersion,
        lastSeenVersion,
      });
      return;
    }

    this.patchSetup({ status: room.status, roomCode: room.code, expectedPlayers: room.expected_players });
    this.syncSetupForExpectedPlayers(room.expected_players);

    console.log("[ONLINE][update]", {
      roomId: room.id,
      status: room.status,
      incomingVersion: hasIncomingVersion ? incomingVersion : null,
      lastSeenVersion,
    });

    if (hasIncomingVersion && incomingVersion > lastSeenVersion + 1) {
      await this.pullRoomState(room.id);
      return;
    }

    if (this.activeRoom && this.activeRoom.id === room.id && hasIncomingVersion) {
      this.activeRoom.version = incomingVersion;
    }
    if (hasIncomingVersion) {
      this.syncLastSeenVersion(incomingVersion);
    }

    if (room.status === "active" && room.game_state) {
      this.gameEngine.applyRemoteGameState(room.game_state, "game:synced");
      this.syncLocalSeatFromGame(room.game_state);
      return;
    }

    if (room.status === "active") {
      await this.pullRoomState(room.id);
    }
  }

  async onMoveIntent(payload) {
    const user = this.authManager.getUser();
    const state = this.stateManager.getState();
    const online = state.setup.online;

    if (!online.isHost || !user || !this.activeRoom) return;

    const body = payload.payload || {};
    if (!body || body.ref === this.localBroadcastRef) return;

    await this.applyIntentAsHost(body);
  }

  onIntentRejected(payload) {
    const body = payload.payload || {};
    const localUserId = this.authManager.getUser()?.id;
    if (!localUserId) return;
    if (body.actorUserId && body.actorUserId !== localUserId) return;
    console.log("[ONLINE][intent_rejected]", {
      roomId: this.activeRoom?.id || this.stateManager.getState().setup.online.roomId || null,
      reason: body.reason || "invalid_move",
      error: body.error || null,
      expectedVersion: body.expectedVersion ?? null,
    });

    if (body.reason === "stale_client") {
      const expectedVersion = Number(body.expectedVersion);
      if (Number.isFinite(expectedVersion) && this.activeRoom) {
        this.activeRoom.version = expectedVersion;
      }
      this.eventBus.emit("online:intent-rejected", {
        reason: "stale_client",
        expectedVersion: Number.isFinite(expectedVersion) ? expectedVersion : null,
        error: body.error || "Resync required.",
      });
      const roomId = this.stateManager.getState().setup.online.roomId || this.activeRoom?.id;
      if (roomId) {
        this.pullRoomState(roomId);
      }
      return;
    }

    this.eventBus.emit("online:intent-rejected", {
      reason: body.reason || "invalid_move",
      error: body.error || "Move rejected.",
    });
    const roomId = this.stateManager.getState().setup.online.roomId || this.activeRoom?.id;
    if (roomId) {
      this.pullRoomState(roomId);
    }
  }

  async broadcastIntentRejected(actorUserId, payload = {}) {
    if (!actorUserId || !this.channel) return;
    await this.channel.send({
      type: "broadcast",
      event: "intent_rejected",
      payload: {
        actorUserId,
        ref: payload.ref || null,
        reason: payload.reason || "invalid_move",
        expectedVersion: payload.expectedVersion ?? null,
        error: payload.error || "Move rejected.",
        at: Date.now(),
      },
    });
  }

  async applyIntentAsHost(intent) {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game) {
      await this.broadcastIntentRejected(intent.actorUserId, {
        ref: intent.ref || null,
        reason: "invalid_move",
        error: "Game not active.",
      });
      return { ok: false, error: "Game not active." };
    }

    const hostRoomVersion = this.getRoomVersion();
    const clientRoomVersion = Number.isFinite(Number(intent.clientRoomVersion))
      ? Number(intent.clientRoomVersion)
      : -1;

    if (clientRoomVersion < hostRoomVersion) {
      console.log("[ONLINE][intent:stale]", {
        roomId: this.activeRoom?.id || null,
        clientRoomVersion,
        hostRoomVersion,
      });
      await this.broadcastIntentRejected(intent.actorUserId, {
        ref: intent.ref || null,
        reason: "stale_client",
        expectedVersion: hostRoomVersion,
        error: "Client state is stale. Resyncing...",
      });
      return { ok: false, error: "Client state is stale." };
    }

    this.hydratePlayerUserIdsFromLobby(game);

    const actorUserId = intent.actorUserId || null;
    let actorPlayerIndex = actorUserId
      ? game.players.findIndex((player) => player.userId === actorUserId)
      : -1;

    if (actorPlayerIndex < 0 && actorUserId) {
      const fallback = this.resolveLocalSeatFromLobby(game, {
        userId: actorUserId,
        allowDisplayNameFallback: false,
      });
      if (fallback) {
        actorPlayerIndex = fallback.index;
      }
    }
    if (actorUserId && actorPlayerIndex < 0) {
      await this.broadcastIntentRejected(intent.actorUserId, {
        ref: intent.ref || null,
        reason: "invalid_move",
        error: "You are not seated in this room.",
      });
      return { ok: false, error: "You are not seated in this room." };
    }

    const actorPlayerId = actorPlayerIndex >= 0 ? game.players[actorPlayerIndex].id : null;
    if (actorPlayerId && intent.playerId && intent.playerId !== actorPlayerId) {
      console.log("[ONLINE][intent:seat-mismatch]", {
        roomId: this.activeRoom?.id || null,
        actorUserId,
        expectedPlayerId: actorPlayerId,
        requestedPlayerId: intent.playerId,
      });
    }

    const resolvedPlayerId = actorPlayerId || intent.playerId;
    if (!resolvedPlayerId) {
      await this.broadcastIntentRejected(intent.actorUserId, {
        ref: intent.ref || null,
        reason: "invalid_move",
        error: "Missing player identity.",
      });
      return { ok: false, error: "Missing player identity." };
    }

    let result = { ok: false };

    if (intent.type === "play") {
      result = this.gameEngine.playCard({
        playerId: resolvedPlayerId,
        cardId: intent.cardId,
        declaredColor: intent.declaredColor,
      });
    }

    if (intent.type === "draw") {
      result = this.gameEngine.drawCard(resolvedPlayerId);
    }

    if (intent.type === "pass") {
      result = this.gameEngine.endTurn(resolvedPlayerId, "pass");
    }

    if (intent.type === "call_uno") {
      result = this.gameEngine.callUno(resolvedPlayerId);
    }

    if (!["play", "draw", "pass", "call_uno"].includes(intent.type)) {
      result = { ok: false, error: "Unknown intent type." };
    }

    if (!result.ok) {
      console.log("[ONLINE][intent:invalid]", {
        roomId: this.activeRoom?.id || null,
        error: result.error || "Move rejected.",
        type: intent.type,
      });
      await this.broadcastIntentRejected(intent.actorUserId, {
        ref: intent.ref || null,
        reason: "invalid_move",
        error: result.error || "Move rejected.",
      });
      return result;
    }

    const pushed = await this.pushGameState();
    if (!pushed.ok) {
      await this.broadcastIntentRejected(intent.actorUserId, {
        ref: intent.ref || null,
        reason: "invalid_move",
        error: pushed.error || "Could not sync game state.",
      });
      return { ok: false, error: pushed.error || "Could not sync game state." };
    }
    return result;
  }

  async pushGameState() {
    if (!this.supabase || !this.activeRoom) {
      return { ok: false, error: "No active room." };
    }

    const game = this.gameEngine.serializeCurrentGame();
    if (!game) {
      return { ok: false, error: "No active game." };
    }

    const status = game.winnerId ? "finished" : "active";
    const nextVersion = (this.activeRoom.version ?? 0) + 1;
    const { data, error } = await this.supabase
      .from("game_rooms")
      .update({
        game_state: game,
        status,
        version: nextVersion,
      })
      .eq("id", this.activeRoom.id)
      .select("version, status, code")
      .single();

    if (error) {
      return { ok: false, error: error.message };
    }

    this.activeRoom.version = data?.version ?? nextVersion;
    this.syncLastSeenVersion(this.activeRoom.version);
    this.patchSetup({
      status: data?.status || status,
      roomCode: data?.code || this.stateManager.getState().setup.online.roomCode,
    });
    console.log("[ONLINE][push]", {
      roomId: this.activeRoom.id,
      version: this.activeRoom.version,
      status: data?.status || status,
      currentTurn: game.currentTurn,
      activeColor: game.activeColor,
      discardTop: game.discardTop?.value ?? game.discardPile?.[game.discardPile.length - 1]?.value ?? null,
    });
    return { ok: true, version: this.activeRoom.version };
  }

  async pullRoomState(roomIdOverride = null) {
    const online = this.stateManager.getState().setup.online;
    const roomId = roomIdOverride || online.roomId;
    if (!this.supabase || !roomId) return;

    if (this.pullRoomStatePromise) {
      this.pullRoomStateQueued = true;
      this.pullRoomStateQueuedRoomId = roomId;
      return this.pullRoomStatePromise;
    }

    this.pullRoomStateInFlight = true;
    this.pullRoomStatePromise = (async () => {
      const { data: room } = await this.supabase
        .from("game_rooms")
        .select("game_state, status, version, code")
        .eq("id", roomId)
        .single();

      const pulledVersion = Number(room?.version);
      const hasPulledVersion = Number.isFinite(pulledVersion);
      const lastSeenVersion = this.getLastSeenVersion();
      if (hasPulledVersion && pulledVersion < lastSeenVersion) {
        console.log("[ONLINE][pull:ignored]", {
          roomId,
          pulledVersion,
          lastSeenVersion,
        });
        return;
      }

      if (room) {
        if (this.activeRoom && this.activeRoom.id === roomId && hasPulledVersion) {
          this.activeRoom.version = pulledVersion;
        }
        if (hasPulledVersion) {
          this.syncLastSeenVersion(pulledVersion);
        }
        this.patchSetup({
          status: room.status || this.stateManager.getState().setup.online.status,
          roomCode: room.code || this.stateManager.getState().setup.online.roomCode,
        });
      }

      console.log("[ONLINE][pull]", {
        roomId,
        version: hasPulledVersion ? pulledVersion : null,
        status: room?.status || null,
        hasGameState: !!room?.game_state,
      });

      if (room?.game_state) {
        this.gameEngine.applyRemoteGameState(room.game_state, "game:synced");
        this.syncLocalSeatFromGame(room.game_state);
      }
    })();

    try {
      await this.pullRoomStatePromise;
    } finally {
      this.pullRoomStatePromise = null;
      this.pullRoomStateInFlight = false;
      if (this.pullRoomStateQueued) {
        const queuedRoomId = this.pullRoomStateQueuedRoomId;
        this.pullRoomStateQueued = false;
        this.pullRoomStateQueuedRoomId = null;
        await this.pullRoomState(queuedRoomId || roomId);
      }
    }
  }

  async startOnlineMatch() {
    const state = this.stateManager.getState();
    const online = state.setup.online;
    const user = this.authManager.getUser();

    if (!this.supabase || !user) return { ok: false, error: "You must sign in first." };
    if (!online.isHost) return { ok: false, error: "Only the host can start the match." };

    if (!online.roomId) return { ok: false, error: "Join or create a room first." };
    if (!online.roomCode) return { ok: false, error: "Room code missing." };
    const snapshot = await this.refreshLobby({ checkAutoStart: false });
    const lobbyPlayers = snapshot?.players || this.stateManager.getState().setup.online.lobbyPlayers;
    const expectedPlayers = snapshot?.expectedPlayers || online.expectedPlayers;
    const roomStatus = snapshot?.room?.status || online.status;

    if (!lobbyPlayers || lobbyPlayers.length < 2) {
      return { ok: false, error: "Need at least 2 players in room." };
    }

    if (roomStatus !== "waiting") {
      return { ok: false, error: "Match already started or finished." };
    }

    if (lobbyPlayers.length !== expectedPlayers) {
      return { ok: false, error: `Waiting for all players (${lobbyPlayers.length}/${expectedPlayers}).` };
    }

    const result = this.gameEngine.startOnlineGame({
      lobbyPlayers,
      roomCode: online.roomCode,
      hostUserId: user.id,
    });

    if (!result.ok) return result;
    this.syncLocalSeatFromGame(result.game);
    const pushed = await this.pushGameState();
    if (!pushed.ok) {
      return { ok: false, error: pushed.error || "Could not sync online match." };
    }
    return { ok: true };
  }

  async maybeAutoStart({ room, players, expectedPlayers }) {
    if (this.autoStartInFlight) return;

    const state = this.stateManager.getState();
    const online = state.setup.online;
    const user = this.authManager.getUser();
    const expected = expectedPlayers || online.expectedPlayers;
    const lobbyPlayers = players || online.lobbyPlayers || [];
    const roomStatus = room?.status || online.status;
    const hostUserId = room?.host_user_id || null;

    if (!user || !online.roomId) return;
    if (!online.isHost) return;
    if (hostUserId && hostUserId !== user.id) return;
    if (roomStatus !== "waiting") return;
    if (!expected || expected < 2) return;
    if (lobbyPlayers.length !== expected) return;

    this.autoStartInFlight = true;
    try {
      await this.startOnlineMatch();
    } finally {
      this.autoStartInFlight = false;
    }
  }

  async sendIntent(intent) {
    if (!this.channel) return { ok: false, error: "No active room channel." };
    const user = this.authManager.getUser();
    const roomVersion = this.getRoomVersion();

    const payload = {
      ...intent,
      actorUserId: user?.id || null,
      clientRoomVersion: Number.isFinite(Number(intent.clientRoomVersion))
        ? Number(intent.clientRoomVersion)
        : roomVersion,
      ref: this.localBroadcastRef,
      at: Date.now(),
    };

    console.log("[ONLINE][intent]", {
      roomId: this.activeRoom?.id || this.stateManager.getState().setup.online.roomId || null,
      type: payload.type,
      actorUserId: payload.actorUserId,
      clientRoomVersion: payload.clientRoomVersion,
      hostRoomVersion: roomVersion,
    });

    if (this.stateManager.getState().setup.online.isHost) {
      const result = await this.applyIntentAsHost(payload);
      if (!result?.ok) {
        return { ok: false, error: result?.error || "Move rejected." };
      }
      return { ok: true };
    }

    await this.channel.send({ type: "broadcast", event: "move_intent", payload });
    return { ok: true };
  }

  async requestPlay({ playerId, cardId, declaredColor, clientRoomVersion }) {
    return this.sendIntent({ type: "play", playerId, cardId, declaredColor, clientRoomVersion });
  }

  async requestDraw({ playerId, clientRoomVersion }) {
    return this.sendIntent({ type: "draw", playerId, clientRoomVersion });
  }

  async requestPass({ playerId, clientRoomVersion }) {
    return this.sendIntent({ type: "pass", playerId, clientRoomVersion });
  }

  async requestCallUno({ playerId, clientRoomVersion }) {
    return this.sendIntent({ type: "call_uno", playerId, clientRoomVersion });
  }
}
