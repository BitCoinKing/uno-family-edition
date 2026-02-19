export class StateManager {
  constructor(eventBus, initialState = {}) {
    this.eventBus = eventBus;
    this.state = initialState;
  }

  getState() {
    return this.state;
  }

  setState(updater, eventName = "state:changed") {
    const nextState = typeof updater === "function" ? updater(this.state) : updater;
    this.state = nextState;
    this.eventBus.emit(eventName, this.state);
    return this.state;
  }
}
