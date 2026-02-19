export class SoundManager {
  constructor() {
    this.enabled = true;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
  }

  playCard() {
    this.stub("playCard");
  }

  playDraw() {
    this.stub("playDraw");
  }

  playSkip() {
    this.stub("playSkip");
  }

  playReverse() {
    this.stub("playReverse");
  }

  playWild() {
    this.stub("playWild");
  }

  playWin() {
    this.stub("playWin");
  }

  playTurnNotification() {
    this.stub("playTurnNotification");
  }

  stub() {
    if (!this.enabled) return;
  }
}
