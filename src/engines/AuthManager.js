export class AuthManager {
  constructor({ eventBus, stateManager }) {
    this.eventBus = eventBus;
    this.stateManager = stateManager;
    this.supabase = null;
    this.authSubscription = null;
  }

  async init(supabase) {
    this.supabase = supabase;

    if (!this.supabase) {
      this.patchAuthState({
        enabled: false,
        loading: false,
        user: null,
        error: "Supabase is not configured.",
      });
      return;
    }

    this.patchAuthState({ enabled: true, loading: true, error: null });

    const { data: { session } } = await this.supabase.auth.getSession();
    this.patchAuthState({
      enabled: true,
      loading: false,
      user: session?.user || null,
      error: null,
    });
    this.eventBus.emit("auth:changed", session?.user || null);

    const { data } = this.supabase.auth.onAuthStateChange((_event, nextSession) => {
      const user = nextSession?.user || null;
      this.patchAuthState({ user, loading: false, enabled: true, error: null });
      this.eventBus.emit("auth:changed", user);
    });

    this.authSubscription = data.subscription;
  }

  patchAuthState(patch) {
    this.stateManager.setState((state) => ({
      ...state,
      auth: {
        ...state.auth,
        ...patch,
      },
    }), "auth:state");
  }

  getUser() {
    return this.stateManager.getState().auth.user;
  }

  async signInWithGoogle() {
    if (!this.supabase) return { ok: false, error: "Supabase is not configured." };

    const redirectTo = `${window.location.origin}`;
    const { error } = await this.supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  async signOut() {
    if (!this.supabase) return { ok: false, error: "Supabase is not configured." };
    const { error } = await this.supabase.auth.signOut();
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  destroy() {
    if (this.authSubscription) {
      this.authSubscription.unsubscribe();
    }
  }
}
