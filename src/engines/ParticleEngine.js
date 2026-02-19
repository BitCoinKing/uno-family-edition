const rand = (min, max) => Math.random() * (max - min) + min;

export class ParticleEngine {
  constructor({ ambientCanvas, effectCanvas }) {
    this.ambientCanvas = ambientCanvas;
    this.effectCanvas = effectCanvas;
    this.ambientCtx = ambientCanvas.getContext("2d");
    this.effectCtx = effectCanvas.getContext("2d");

    this.ambientParticles = [];
    this.effectParticles = [];
    this.running = false;
    this.rafId = null;

    this.resize = this.debounce(() => this.handleResize(), 120);
    window.addEventListener("resize", this.resize);
  }

  init() {
    this.handleResize();
    this.spawnAmbient();
    this.running = true;
    this.tick();
  }

  destroy() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.resize);
  }

  debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  handleResize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;

    [this.ambientCanvas, this.effectCanvas].forEach((canvas) => {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    });

    this.ambientCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.effectCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  spawnAmbient() {
    const count = Math.max(20, Math.floor(window.innerWidth / 55));
    this.ambientParticles = Array.from({ length: count }, () => ({
      x: rand(0, window.innerWidth),
      y: rand(0, window.innerHeight),
      vx: rand(-0.06, 0.06),
      vy: rand(-0.12, -0.03),
      radius: rand(1.2, 2.8),
      alpha: rand(0.08, 0.28),
    }));
  }

  emitCardBurst(x, y, color = "#ffffff") {
    for (let i = 0; i < 16; i++) {
      const angle = (Math.PI * 2 * i) / 16;
      this.effectParticles.push({
        kind: "dot",
        x,
        y,
        vx: Math.cos(angle) * rand(0.8, 2.3),
        vy: Math.sin(angle) * rand(0.8, 2.3),
        gravity: 0.02,
        life: rand(28, 44),
        maxLife: 44,
        size: rand(2.5, 5.5),
        color,
        alpha: 1,
      });
    }
  }

  emitWildExplosion(x, y) {
    const colors = ["#f94144", "#f9c74f", "#43aa8b", "#577590"];
    for (let i = 0; i < 36; i++) {
      const color = colors[i % colors.length];
      this.effectParticles.push({
        kind: "dot",
        x,
        y,
        vx: rand(-3.1, 3.1),
        vy: rand(-3.1, 3.1),
        gravity: 0.04,
        life: rand(32, 56),
        maxLife: 56,
        size: rand(2.5, 6.5),
        color,
        alpha: 1,
      });
    }
  }

  emitReverseTrail(x, y) {
    for (let i = 0; i < 18; i++) {
      const t = (i / 18) * Math.PI * 2;
      this.effectParticles.push({
        kind: "dot",
        x: x + Math.cos(t) * 4,
        y: y + Math.sin(t) * 4,
        vx: Math.cos(t) * rand(1.0, 2.5),
        vy: Math.sin(t) * rand(1.0, 2.5),
        gravity: 0.01,
        life: rand(24, 42),
        maxLife: 42,
        size: rand(2, 4.2),
        color: "#8dd3ff",
        alpha: 1,
      });
    }
  }

  emitSkipPulse(x, y) {
    this.effectParticles.push({
      kind: "ring",
      x,
      y,
      radius: 12,
      growth: 2.3,
      life: 24,
      maxLife: 24,
      alpha: 0.9,
      color: "#ffffff",
    });
  }

  emitConfettiFullScreen() {
    const width = window.innerWidth;
    for (let i = 0; i < 260; i++) {
      this.effectParticles.push({
        kind: "confetti",
        x: rand(0, width),
        y: rand(-window.innerHeight * 0.4, -20),
        vx: rand(-1.8, 1.8),
        vy: rand(1.2, 4.8),
        gravity: 0.045,
        life: rand(160, 260),
        maxLife: 260,
        width: rand(5, 10),
        height: rand(8, 14),
        rotation: rand(0, Math.PI * 2),
        spin: rand(-0.2, 0.2),
        alpha: 1,
        color: ["#f94144", "#f9c74f", "#90be6d", "#577590", "#f3722c"][i % 5],
      });
    }
  }

  tick = () => {
    if (!this.running) return;

    this.renderAmbient();
    this.renderEffects();

    this.rafId = requestAnimationFrame(this.tick);
  };

  renderAmbient() {
    const ctx = this.ambientCtx;
    const width = window.innerWidth;
    const height = window.innerHeight;
    ctx.clearRect(0, 0, width, height);

    this.ambientParticles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -10) {
        p.y = height + 10;
        p.x = rand(0, width);
      }
      if (p.x < -10) p.x = width + 10;
      if (p.x > width + 10) p.x = -10;

      ctx.beginPath();
      ctx.fillStyle = `rgba(255,255,255,${p.alpha})`;
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  renderEffects() {
    const ctx = this.effectCtx;
    const width = window.innerWidth;
    const height = window.innerHeight;

    ctx.clearRect(0, 0, width, height);

    this.effectParticles = this.effectParticles.filter((p) => p.life > 0 && p.alpha > 0.01 && p.y < height + 80);

    this.effectParticles.forEach((p) => {
      p.life -= 1;
      p.alpha = p.life / p.maxLife;

      if (p.kind === "ring") {
        p.radius += p.growth;
        ctx.beginPath();
        ctx.strokeStyle = `rgba(255,255,255,${p.alpha})`;
        ctx.lineWidth = 3;
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.stroke();
        return;
      }

      p.vy += p.gravity || 0;
      p.x += p.vx;
      p.y += p.vy;

      if (p.kind === "confetti") {
        p.rotation += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.alpha;
        ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
        ctx.restore();
        ctx.globalAlpha = 1;
        return;
      }

      ctx.beginPath();
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }
}
