(() => {
  "use strict";

  const A = window.MyaLotto = {};

  A.MAX_REELS = 7;
  A.DEFAULT_MAX = 45;
  A.DEFAULT_COUNT = 7;
  A.HISTORY_STORAGE_KEY = "lucky-mouth-roulette.history.v1";
  A.SETTINGS_STORAGE_KEY = "mya-lotto.settings.v1";
  A.CHECKER_STORAGE_KEY = "mya-lotto.checker.v1";

  A.el = {
    canvas: document.getElementById("teethCanvas"),
    stage: document.getElementById("characterStage"),
    stageStatus: document.getElementById("stageStatus"),
    maxNumberInput: document.getElementById("maxNumber"),
    drawCountInput: document.getElementById("drawCount"),
    autoDrawCountInput: document.getElementById("autoDrawCount"),
    drawModeInputs: [...document.querySelectorAll('input[name="drawMode"]')],
    autoRepeatSetting: document.getElementById("autoRepeatSetting"),
    modeDescription: document.getElementById("modeDescription"),
    resultNumbers: document.getElementById("resultNumbers"),
    copyCurrentButton: document.getElementById("copyCurrentButton"),
    copyAllButton: document.getElementById("copyAllButton"),
    clearHistoryButton: document.getElementById("clearHistoryButton"),
    historyList: document.getElementById("historyList"),
    emptyHistory: document.getElementById("emptyHistory"),
    toast: document.getElementById("toast"),
    tabButtons: [...document.querySelectorAll(".tab-button")],
    drawPanel: document.getElementById("drawPanel"),
    checkPanel: document.getElementById("checkPanel"),
    winningNumbersInput: document.getElementById("winningNumbers"),
    bonusNumberInput: document.getElementById("bonusNumber"),
    checkNumbersButton: document.getElementById("checkNumbersButton"),
    checkerSummary: document.getElementById("checkerSummary"),
    checkedCount: document.getElementById("checkedCount"),
    bestResult: document.getElementById("bestResult"),
    prizeCount: document.getElementById("prizeCount"),
    checkerResults: document.getElementById("checkerResults"),
    emptyChecker: document.getElementById("emptyChecker")
  };

  A.ctx = A.el.canvas.getContext("2d");
  A.state = {
    activeTab: "draw",
    appState: "idle",
    currentResult: [],
    currentDrawSettings: null,
    history: [],
    visibleReelCount: A.DEFAULT_COUNT,
    activeReels: Array.from({ length: A.DEFAULT_COUNT }, (_, i) => i),
    previousFrameTime: performance.now(),
    toastTimer: 0,
    manualNextIndex: 0,
    manualStopPending: false,
    autoDrawRunning: false,
    autoDrawTarget: 0,
    autoDrawCompleted: 0,
    autoCancelRequested: false,
    autoTimer: 0
  };

  A.modulo = (value, mod) => ((value % mod) + mod) % mod;
  A.lerp = (a, b, t) => a + (b - a) * t;
  A.easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);

  A.secureRandomInt = (min, max) => {
    const range = max - min + 1;
    if (range <= 0) throw new RangeError("Invalid random range");
    const maxUint = 0x100000000;
    const limit = maxUint - (maxUint % range);
    const array = new Uint32Array(1);
    let value;
    do {
      crypto.getRandomValues(array);
      value = array[0];
    } while (value >= limit);
    return min + (value % range);
  };

  A.randomFloat = (min, max) => {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return min + (buffer[0] / 0xffffffff) * (max - min);
  };

  A.formatDisplayNumber = (value, max) => {
    if (!Number.isFinite(value)) return "—";
    const width = Math.max(1, String(Math.max(1, max || A.DEFAULT_MAX)).length);
    return String(value).padStart(width, "0");
  };

  A.formatRecordNumbers = (record) => {
    const max = Number.isFinite(record.max) ? record.max : A.DEFAULT_MAX;
    return record.numbers.map((value) => A.formatDisplayNumber(value, max)).join("  ");
  };

  A.showToast = (message) => {
    const { toast } = A.el;
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(A.state.toastTimer);
    A.state.toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1800);
  };

  A.copyText = async (text, message) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      A.showToast(message);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      A.showToast(message);
    }
  };

  class ToothReel {
    constructor(index) {
      this.index = index;
      this.reset();
    }

    reset() {
      this.position = this.index * 2.31;
      this.speed = 26 + this.index * 0.9;
      this.mode = "idle";
      this.max = A.DEFAULT_MAX;
      this.target = null;
      this.stopStart = 0;
      this.stopFrom = 0;
      this.stopTo = 0;
      this.stopDuration = 0;
      this.flash = 0;
      this.stopNotified = false;
    }

    start(max) {
      this.max = max;
      this.position = A.randomFloat(0, 80) + this.index * 0.37;
      this.speed = A.randomFloat(27, 36) + this.index * 0.75;
      this.mode = "spinning";
      this.target = null;
      this.flash = 0;
      this.stopNotified = false;
    }

    beginStop(target, now, duration) {
      if (this.mode !== "spinning") return false;
      this.target = target;
      this.mode = "stopping";
      this.stopStart = now;
      this.stopFrom = this.position;
      this.stopTo = Math.ceil(this.position) + 15 + this.index * 2 + A.secureRandomInt(0, 5);
      this.stopDuration = duration;
      this.stopNotified = false;
      return true;
    }

    update(dt, now) {
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.4);
      if (this.mode === "spinning") {
        this.position += this.speed * dt;
        return false;
      }
      if (this.mode === "stopping") {
        const t = Math.min(1, (now - this.stopStart) / this.stopDuration);
        this.position = A.lerp(this.stopFrom, this.stopTo, A.easeOutQuint(t));
        if (t >= 1) {
          this.position = this.stopTo;
          this.mode = "stopped";
          this.flash = 1;
          if (!this.stopNotified) {
            this.stopNotified = true;
            return true;
          }
        }
      }
      return false;
    }

    visualValue(step) {
      if (this.target != null && Math.round(step) === Math.round(this.stopTo)) return this.target;
      if (this.mode === "stopped" && this.target != null) return this.target;
      let x = (step + 1) * 0x45d9f3b + (this.index + 11) * 0x27d4eb2d;
      x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
      x ^= x >>> 16;
      return A.modulo(Math.abs(x), this.max) + 1;
    }
  }

  A.reels = Array.from({ length: A.MAX_REELS }, (_, i) => new ToothReel(i));

  function resizeCanvas() {
    const rect = A.el.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (A.el.canvas.width !== width || A.el.canvas.height !== height) {
      A.el.canvas.width = width;
      A.el.canvas.height = height;
    }
    return { dpr, width: rect.width, height: rect.height };
  }

  function roundedRectPath(width, height, radius) {
    const p = new Path2D();
    const x = -width / 2;
    const y = -height / 2;
    const r = Math.min(radius, width / 2, height / 2);
    p.moveTo(x + r, y);
    p.lineTo(x + width - r, y);
    p.quadraticCurveTo(x + width, y, x + width, y + r);
    p.lineTo(x + width, y + height - r);
    p.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    p.lineTo(x + r, y + height);
    p.quadraticCurveTo(x, y + height, x, y + height - r);
    p.lineTo(x, y + r);
    p.quadraticCurveTo(x, y, x + r, y);
    p.closePath();
    return p;
  }

  function drawReelFace(width, height, value, max, alpha = 1) {
    const ctx = A.ctx;
    const face = roundedRectPath(width, height, Math.min(width, height) * 0.12);
    const gradient = ctx.createLinearGradient(0, -height / 2, 0, height / 2);
    gradient.addColorStop(0, "rgba(255,255,251,.99)");
    gradient.addColorStop(0.48, "rgba(255,246,232,.99)");
    gradient.addColorStop(1, "rgba(226,195,173,.99)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    ctx.shadowColor = "rgba(74, 15, 7, .30)";
    ctx.shadowBlur = Math.max(1, height * 0.045);
    ctx.fill(face);
    ctx.lineWidth = Math.max(0.35, height * 0.016);
    ctx.strokeStyle = "rgba(123, 61, 38, .26)";
    ctx.stroke(face);
    if (value != null) {
      ctx.fillStyle = "#762818";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `900 ${Math.min(height * 0.48, width * 0.58)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.shadowColor = "rgba(255,255,255,.58)";
      ctx.shadowBlur = 1;
      ctx.fillText(A.formatDisplayNumber(value, max), 0, 0);
    }
    ctx.globalAlpha = 1;
  }

  function renderTeeth() {
    const ctx = A.ctx;
    const { dpr, width: w, height: h } = resizeCanvas();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    const count = Math.max(1, Math.min(A.MAX_REELS, A.state.visibleReelCount));
    const normalSlotW = (w * 0.96) / A.MAX_REELS;
    const groupW = normalSlotW * count;
    const groupLeft = (w - groupW) / 2;
    const faceW = normalSlotW * 0.91;
    const faceH = h * 0.82;
    const centerY = h * 0.5;
    const rowStep = faceH * 0.92;

    ctx.fillStyle = "rgba(18, 2, 4, .98)";
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < count; i++) {
      const reel = A.reels[i];
      const x = groupLeft + normalSlotW * (i + 0.5);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - normalSlotW * 0.49, 0, normalSlotW * 0.98, h);
      ctx.clip();

      if (reel.mode === "idle") {
        ctx.save();
        ctx.translate(x, centerY);
        drawReelFace(faceW, faceH, null, reel.max);
        ctx.restore();
      } else {
        const base = Math.floor(reel.position);
        const frac = reel.position - base;
        for (let offset = -2; offset <= 2; offset++) {
          const step = base + offset;
          const y = centerY + (offset - frac) * rowStep;
          const distance = Math.abs(y - centerY) / rowStep;
          const alpha = Math.max(0.3, 1 - distance * 0.2);
          ctx.save();
          ctx.translate(x, y);
          drawReelFace(faceW, faceH, reel.visualValue(step), reel.max, alpha);
          ctx.restore();
        }
      }
      ctx.restore();

      if (reel.flash > 0) {
        const glow = ctx.createRadialGradient(x, centerY, 0, x, centerY, normalSlotW);
        glow.addColorStop(0, `rgba(255, 243, 179, ${0.72 * reel.flash})`);
        glow.addColorStop(1, "rgba(255, 173, 44, 0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x - normalSlotW, 0, normalSlotW * 2, h);
      }
    }
    ctx.restore();
  }

  A.startAnimation = () => {
    const animate = (now) => {
      const dt = Math.min(0.05, (now - A.state.previousFrameTime) / 1000);
      A.state.previousFrameTime = now;
      A.state.activeReels.forEach((index) => {
        if (A.reels[index].update(dt, now) && A.handleReelStopped) A.handleReelStopped(index);
      });
      renderTeeth();
      if (
        A.state.appState === "stopping" &&
        A.state.activeReels.length > 0 &&
        A.state.activeReels.every((index) => A.reels[index].mode === "stopped") &&
        A.finalizeDraw
      ) {
        A.finalizeDraw();
      }
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  };
})();