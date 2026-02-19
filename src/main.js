import { EventBus } from "./core/EventBus.js";
import { StateManager } from "./core/StateManager.js";
import { StatsManager } from "./core/StatsManager.js";
import { GameEngine } from "./core/GameEngine.js";

import { UIEngine } from "./ui/UIEngine.js";

import { AIEngine } from "./engines/AIEngine.js";
import { AnimationEngine } from "./engines/AnimationEngine.js";
import { ParticleEngine } from "./engines/ParticleEngine.js";
import { SoundManager } from "./engines/SoundManager.js";
import { AuthManager } from "./engines/AuthManager.js";
import { OnlineEngine } from "./engines/OnlineEngine.js";

import { createSupabase } from "./services/createSupabaseClient.js";
import { loadRuntimeConfig } from "./services/loadRuntimeConfig.js";

const eventBus = new EventBus();

const initialState = {
  screen: "landing",
  setup: {
    selectedPlayers: 3,
    mode: "local",
    playerNames: ["DAD", "LILY", "LIA"],
    online: {
      enabled: false,
      loading: false,
      roomId: null,
      roomCode: "",
      expectedPlayers: 3,
      isHost: false,
      status: "offline",
      lobbyPlayers: [],
      localDisplayName: "",
      error: null,
    },
  },
  auth: {
    enabled: false,
    loading: true,
    user: null,
    error: null,
  },
  game: null,
  ui: {
    scoreboardOpen: false,
    settingsOpen: false,
    turnBanner: "",
  },
};

const stateManager = new StateManager(eventBus, initialState);
const soundManager = new SoundManager();
const statsManager = new StatsManager(eventBus);
const animationEngine = new AnimationEngine();
const particleEngine = new ParticleEngine({
  ambientCanvas: document.getElementById("ambient-canvas"),
  effectCanvas: document.getElementById("effect-canvas"),
});

const gameEngine = new GameEngine({
  stateManager,
  eventBus,
  statsManager,
  soundManager,
});

const authManager = new AuthManager({ eventBus, stateManager });
const onlineEngine = new OnlineEngine({ eventBus, stateManager, gameEngine, authManager });

const uiEngine = new UIEngine({
  root: document.getElementById("screen-root"),
  stateManager,
  eventBus,
  gameEngine,
  authManager,
  onlineEngine,
  statsManager,
  animationEngine,
  particleEngine,
  soundManager,
});

new AIEngine({ eventBus, stateManager, gameEngine });

particleEngine.init();
uiEngine.mount();

const runtimeConfig = await loadRuntimeConfig();
const supabase = createSupabase(runtimeConfig.supabaseUrl, runtimeConfig.supabaseAnonKey);
onlineEngine.setClient(supabase);
await authManager.init(supabase);

window.addEventListener("beforeunload", () => {
  particleEngine.destroy();
  authManager.destroy();
});
