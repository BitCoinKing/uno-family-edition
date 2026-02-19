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
    this.activeStatePullTimer = null;
    this.uiStatusTimer = null;
    this.activeTransitionTimer = null;

    this.eventBus.on("auth:changed", async () => {
      await this.refreshLobby();
      await this.tryAutoJoinFromInvite();
    });
  }

  setClient(supabase) {
    this.supabase = supabase;
    this.patchSetup({ enabled: !!supabase });
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
    const result = await this.joinRoom({ roomCode: code, displayName: preferred });

    if (result.ok) {
      this.patchSetup({ pendingInviteCode: "", pendingInviteToken: "" });
      this.clearInviteParamsFromLocation();
      this.eventBus.emit("online:autojoined", { roomCode: code });
    } else {
      this.patchSetup({ pendingInviteError: result.error || "Invite join failed." });
      this.eventBus.emit("online:autojoin-failed", { error: result.error || "Invite join failed." });
    }
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
    });

    if (snapshot?.room?.status !== "active") {
      this.setTransientUiStatus("Joined ✅ Waiting for host…", 900);
    }

    if (snapshot?.room?.status === "active") {
      this.setTransientUiStatus("Starting match…", 500);
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
      .select("status, expected_players, host_user_id, code")
      .eq("id", online.roomId)
      .single();

    const expectedPlayers = room?.expected_players || online.expectedPlayers;
    this.syncSetupForExpectedPlayers(expectedPlayers);

    const user = this.authManager.getUser();
    this.patchSetup({
      lobbyPlayers: players || [],
      status: room?.status || online.status,
      roomCode: room?.code || online.roomCode,
      expectedPlayers,
      isHost: user?.id ? room?.host_user_id === user.id : false,
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
  }

  async teardownRoom() {
    if (this.channel && this.supabase) {
      await this.supabase.removeChannel(this.channel);
    }
    if (this.activeStatePullTimer) {
      clearTimeout(this.activeStatePullTimer);
      this.activeStatePullTimer = null;
    }
    if (this.uiStatusTimer) {
      clearTimeout(this.uiStatusTimer);
      this.uiStatusTimer = null;
    }
    if (this.activeTransitionTimer) {
      clearTimeout(this.activeTransitionTimer);
      this.activeTransitionTimer = null;
    }
    this.channel = null;
    this.activeRoom = null;
  }

  async onRoomUpdated(room) {
    const state = this.stateManager.getState();
    const previousStatus = state.setup.online.status;
    const becameActive = previousStatus !== "active" && room.status === "active";

    if (this.activeRoom && this.activeRoom.id === room.id) {
      this.activeRoom.version = room.version || this.activeRoom.version || 0;
    }
    this.patchSetup({ status: room.status, roomCode: room.code, expectedPlayers: room.expected_players });
    this.syncSetupForExpectedPlayers(room.expected_players);

    if (becameActive) {
      this.setTransientUiStatus("Starting match…", 500);
    }

    if (room.game_state) {
      const shouldDelayTransition = becameActive && state.screen !== "game";
      if (shouldDelayTransition) {
        if (this.activeTransitionTimer) {
          clearTimeout(this.activeTransitionTimer);
        }
        this.activeTransitionTimer = setTimeout(() => {
          this.activeTransitionTimer = null;
          this.gameEngine.applyRemoteGameState(room.game_state, "game:synced");
        }, 420);
      } else {
        if (this.activeTransitionTimer) {
          clearTimeout(this.activeTransitionTimer);
          this.activeTransitionTimer = null;
        }
        this.gameEngine.applyRemoteGameState(room.game_state, "game:synced");
      }
      return;
    }

    if (room.status === "active") {
      this.scheduleActiveStatePull(becameActive ? 420 : 150);
    }
  }

  scheduleActiveStatePull(delayMs = 150) {
    if (this.activeStatePullTimer) {
      clearTimeout(this.activeStatePullTimer);
    }
    this.activeStatePullTimer = setTimeout(async () => {
      this.activeStatePullTimer = null;
      const roomId = this.stateManager.getState().setup.online.roomId || this.activeRoom?.id;
      if (!roomId) return;
      await this.pullRoomState(roomId);
    }, delayMs);
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

  async applyIntentAsHost(intent) {
    const state = this.stateManager.getState();
    const game = state.game;
    if (!game) return;

    let result = { ok: false };

    if (intent.type === "play") {
      result = this.gameEngine.playCard({
        playerId: intent.playerId,
        cardId: intent.cardId,
        declaredColor: intent.declaredColor,
      });
    }

    if (intent.type === "draw") {
      result = this.gameEngine.drawCard(intent.playerId, { passTurn: true });
    }

    if (intent.type === "pass") {
      result = this.gameEngine.endTurn(intent.playerId, "pass");
    }

    if (result.ok) {
      await this.pushGameState();
    }
  }

  async pushGameState() {
    if (!this.supabase || !this.activeRoom) return;

    const game = this.gameEngine.serializeCurrentGame();
    if (!game) return;

    const status = game.winnerId ? "finished" : "active";
    await this.supabase
      .from("game_rooms")
      .update({
        game_state: game,
        status,
        version: (this.activeRoom.version || 0) + 1,
      })
      .eq("id", this.activeRoom.id);

    this.activeRoom.version = (this.activeRoom.version || 0) + 1;
  }

  async pullRoomState(roomIdOverride = null) {
    if (this.pullRoomStateInFlight) return;
    const online = this.stateManager.getState().setup.online;
    const roomId = roomIdOverride || online.roomId;
    if (!this.supabase || !roomId) return;

    this.pullRoomStateInFlight = true;
    try {
      const { data: room } = await this.supabase
        .from("game_rooms")
        .select("game_state, status")
        .eq("id", roomId)
        .single();

      if (room?.game_state) {
        if (this.activeTransitionTimer) {
          clearTimeout(this.activeTransitionTimer);
          this.activeTransitionTimer = null;
        }
        this.gameEngine.applyRemoteGameState(room.game_state, "game:synced");
      }
    } finally {
      this.pullRoomStateInFlight = false;
    }
  }

  async startOnlineMatch() {
    const state = this.stateManager.getState();
    const online = state.setup.online;
    const user = this.authManager.getUser();

    if (!this.supabase || !user) return { ok: false, error: "You must sign in first." };
    if (!online.isHost) return { ok: false, error: "Only the host can start the match." };

    if (!online.roomId) return { ok: false, error: "Join or create a room first." };
    const snapshot = await this.refreshLobby({ checkAutoStart: false });
    const lobbyPlayers = snapshot?.players || this.stateManager.getState().setup.online.lobbyPlayers;
    const expectedPlayers = snapshot?.expectedPlayers || online.expectedPlayers;

    if (!lobbyPlayers || lobbyPlayers.length < 2) {
      return { ok: false, error: "Need at least 2 players in room." };
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
    await this.pushGameState();
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

    const payload = {
      ...intent,
      ref: this.localBroadcastRef,
      at: Date.now(),
    };

    if (this.stateManager.getState().setup.online.isHost) {
      await this.applyIntentAsHost(payload);
      return { ok: true };
    }

    await this.channel.send({ type: "broadcast", event: "move_intent", payload });
    return { ok: true };
  }

  async requestPlay({ playerId, cardId, declaredColor }) {
    return this.sendIntent({ type: "play", playerId, cardId, declaredColor });
  }

  async requestDraw({ playerId }) {
    return this.sendIntent({ type: "draw", playerId });
  }

  async requestPass({ playerId }) {
    return this.sendIntent({ type: "pass", playerId });
  }
}
