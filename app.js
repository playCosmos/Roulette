(() => {
  "use strict";

  const REEL_COUNT = 7;
  const STORAGE_KEY = "lucky-mouth-roulette.history.v1";
  const DEFAULT_MAX = 45;

  const canvas = document.getElementById("teethCanvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("characterStage");
  const stageStatus = document.getElementById("stageStatus");
  const maxNumberInput = document.getElementById("maxNumber");
  const allowDuplicatesInput = document.getElementById("allowDuplicates");
  const resultNumbers = document.getElementById("resultNumbers");
  const copyCurrentButton = document.getElementById("copyCurrentButton");
  const copyAllButton = document.getElementById("copyAllButton");
  const clearHistoryButton = document.getElementById("clearHistoryButton");
  const historyList = document.getElementById("historyList");
  const emptyHistory = document.getElementById("emptyHistory");
  const toast = document.getElementById("toast");

  let appState = "idle";
  let currentResult = [];
  let history = loadHistory();
  let previousFrameTime = performance.now();
  let toastTimer = 0;

  class ToothReel {
    constructor(index) {
      this.index = index;
      this.phase = index * 0.19;
      this.speed = 10 + index * 0.55;
      this.mode = "idle";
      this.max = DEFAULT_MAX;
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
      this.phase = randomFloat(0, 40) + this.index * 0.23;
      this.speed = randomFloat(10.8, 14.8) + this.index * 0.32;
      this.mode = "spinning";
      this.target = null;
      this.flash = 0;
      this.stopNotified = false;
    }

    beginStop(target, now, duration) {
      if (this.mode !== "spinning") return;

      this.target = target;
      this.mode = "stopping";
      this.stopStart = now;
      this.stopFrom = this.phase;
      this.stopTo = Math.ceil(this.phase) + 10 + this.index * 2 + secureRandomInt(0, 3);
      this.stopDuration = duration;
      this.stopNotified = false;
    }

    update(dt, now) {
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.4);

      if (this.mode === "spinning") {
        this.phase += this.speed * dt;
        return false;
      }

      if (this.mode === "stopping") {
        const t = Math.min(1, (now - this.stopStart) / this.stopDuration);
        this.phase = lerp(this.stopFrom, this.stopTo, easeOutQuint(t));

        if (t >= 1) {
          this.phase = this.stopTo;
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
      if (this.mode === "stopped" && this.target != null) return this.target;

      let x = (step + 1) * 0x45d9f3b + (this.index + 11) * 0x27d4eb2d;
      x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
      x ^= x >>> 16;
      return modulo(Math.abs(x), this.max) + 1;
    }
  }

  const reels = Array.from({ length: REEL_COUNT }, (_, i) => new ToothReel(i));

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    return { dpr, width: rect.width, height: rect.height };
  }

  function mouthClipPath(w, h) {
    const p = new Path2D();
    p.moveTo(w * 0.02, h * 0.06);
    p.bezierCurveTo(w * 0.18, h * 0.015, w * 0.82, h * 0.015, w * 0.98, h * 0.06);
    p.lineTo(w * 0.98, h * 0.56);
    p.bezierCurveTo(w * 0.96, h * 0.86, w * 0.82, h * 0.96, w * 0.50, h * 0.98);
    p.bezierCurveTo(w * 0.18, h * 0.96, w * 0.04, h * 0.86, w * 0.02, h * 0.56);
    p.closePath();
    return p;
  }

  function toothPath(width, height) {
    const p = new Path2D();
    const r = Math.min(width, height) * 0.16;
    const taper = width * 0.055;

    p.moveTo(-width / 2 + r, -height / 2);
    p.quadraticCurveTo(-width / 2, -height / 2, -width / 2, -height / 2 + r);
    p.lineTo(-width / 2 + taper, height / 2 - r);
    p.quadraticCurveTo(-width / 2 + taper, height / 2, -width / 2 + taper + r, height / 2);
    p.lineTo(width / 2 - taper - r, height / 2);
    p.quadraticCurveTo(width / 2 - taper, height / 2, width / 2 - taper, height / 2 - r);
    p.lineTo(width / 2, -height / 2 + r);
    p.quadraticCurveTo(width / 2, -height / 2, width / 2 - r, -height / 2);
    p.closePath();

    return p;
  }

  function renderTeeth() {
    const { dpr, width: w, height: h } = resizeCanvas();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const clip = mouthClipPath(w, h);
    ctx.save();
    ctx.clip(clip);

    const left = w * 0.025;
    const right = w * 0.975;
    const areaW = right - left;
    const slotW = areaW / REEL_COUNT;
    const baseW = slotW * 0.92;
    const baseH = h * 0.88;
    const centerY = h * 0.47;

    for (let i = 0; i < REEL_COUNT; i++) {
      const reel = reels[i];
      const nearest = Math.round(reel.phase);
      const frac = reel.phase - nearest;
      const angle = frac * Math.PI;
      const faceCos = Math.cos(angle);
      const scaleY = reel.mode === "idle" ? 1 : Math.max(0.045, Math.abs(faceCos));
      const x = left + slotW * (i + 0.5);
      const arch = Math.abs(i - 3) * h * 0.014;
      const y = centerY + arch + (reel.mode === "idle" ? 0 : Math.sin(angle) * h * 0.025);
      const tooth = toothPath(baseW, baseH);
      const isBackFace = reel.mode !== "idle" && faceCos < 0;
      const value = reel.mode === "idle" ? null : reel.visualValue(nearest + (isBackFace ? 1 : 0));

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, scaleY);

      const g = ctx.createLinearGradient(0, -baseH / 2, 0, baseH / 2);
      if (isBackFace) {
        g.addColorStop(0, "#d5b79e");
        g.addColorStop(0.52, "#c6a48c");
        g.addColorStop(1, "#9b7460");
      } else {
        g.addColorStop(0, "#fffdf5");
        g.addColorStop(0.50, "#fff3e4");
        g.addColorStop(1, "#e7c6af");
      }

      ctx.fillStyle = g;
      ctx.shadowColor = "rgba(83, 18, 8, .42)";
      ctx.shadowBlur = Math.max(1, h * 0.055);
      ctx.fill(tooth);

      ctx.lineWidth = Math.max(0.45, w * 0.0018);
      ctx.strokeStyle = "rgba(125, 61, 39, .34)";
      ctx.stroke(tooth);

      const shine = ctx.createLinearGradient(-baseW / 2, 0, baseW / 2, 0);
      shine.addColorStop(0, "rgba(255,255,255,0)");
      shine.addColorStop(0.33, "rgba(255,255,255,.16)");
      shine.addColorStop(0.5, "rgba(255,255,255,.54)");
      shine.addColorStop(0.66, "rgba(255,255,255,.13)");
      shine.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = shine;
      ctx.fill(tooth);

      if (value != null && scaleY > 0.18) {
        const fontSize = Math.min(baseW * 0.48, baseH * 0.52);
        ctx.globalAlpha = Math.min(1, (scaleY - 0.12) / 0.42);
        ctx.fillStyle = isBackFace ? "#673428" : "#7d2d18";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `900 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
        ctx.shadowColor = "rgba(255,255,255,.55)";
        ctx.shadowBlur = 1;
        ctx.fillText(formatDisplayNumber(value, reel.max), 0, 0.3);
      }

      ctx.restore();

      if (reel.flash > 0) {
        const glow = ctx.createRadialGradient(x, centerY, 0, x, centerY, slotW * 0.9);
        glow.addColorStop(0, `rgba(255, 243, 179, ${0.72 * reel.flash})`);
        glow.addColorStop(1, "rgba(255, 173, 44, 0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x - slotW, 0, slotW * 2, h);
      }
    }

    ctx.restore();
  }

  function animate(now) {
    const dt = Math.min(0.05, (now - previousFrameTime) / 1000);
    previousFrameTime = now;

    reels.forEach((reel) => {
      if (reel.update(dt, now)) onReelStopped(reel.index);
    });

    renderTeeth();

    if (appState === "stopping" && reels.every((reel) => reel.mode === "stopped")) {
      finalizeDraw();
    }

    requestAnimationFrame(animate);
  }

  function toggleDraw() {
    if (appState === "idle" || appState === "result") {
      startSpin();
    } else if (appState === "spinning") {
      stopSpin();
    }
  }

  function startSpin() {
    if (appState === "spinning" || appState === "stopping") return;

    const max = getMaxNumber(true);
    if (max == null) return;

    appState = "spinning";
    currentResult = [];
    stage.classList.remove("final-win");
    setResultPlaceholders();
    reels.forEach((reel) => reel.start(max));

    maxNumberInput.disabled = true;
    allowDuplicatesInput.disabled = true;
    copyCurrentButton.disabled = true;
    stageStatus.textContent = "7개의 이빨이 회전 중 · 다시 클릭하면 정지";
  }

  function stopSpin() {
    if (appState !== "spinning") return;

    const max = getMaxNumber(true);
    if (max == null) return;

    currentResult = drawNumbers(REEL_COUNT, max, allowDuplicatesInput.checked);
    appState = "stopping";
    stageStatus.textContent = "왼쪽 이빨부터 하나씩 정지 중…";

    currentResult.forEach((target, i) => {
      const delay = i * 300 + (i === REEL_COUNT - 1 ? 650 : 0);
      const duration = 880 + i * 45 + (i === REEL_COUNT - 1 ? 260 : 0);
      window.setTimeout(() => {
        reels[i].beginStop(target, performance.now(), duration);
      }, delay);
    });
  }

  function onReelStopped(index) {
    const cell = resultNumbers.children[index];
    if (cell) {
      cell.textContent = formatDisplayNumber(currentResult[index], getMaxNumber(false));
      cell.classList.remove("pop");
      void cell.offsetWidth;
      cell.classList.add("pop");
    }

    stageStatus.textContent = index < REEL_COUNT - 1
      ? `${index + 1} / ${REEL_COUNT} 정지 · 다음 이빨 감속 중…`
      : "마지막 번호 확정!";
  }

  function finalizeDraw() {
    if (appState !== "stopping") return;

    appState = "result";
    maxNumberInput.disabled = false;
    allowDuplicatesInput.disabled = false;
    copyCurrentButton.disabled = false;

    stage.classList.add("final-win");
    window.setTimeout(() => stage.classList.remove("final-win"), 1000);

    const record = {
      max: getMaxNumber(false),
      allowDuplicates: allowDuplicatesInput.checked,
      numbers: currentResult.slice()
    };

    history.unshift(record);
    history = history.slice(0, 200);
    saveHistory();
    renderHistory();

    stageStatus.textContent = `완료 · ${currentResult.map((n) => formatDisplayNumber(n, record.max)).join("  ")}`;
  }

  function getMaxNumber(showError) {
    const parsed = Number.parseInt(maxNumberInput.value, 10);
    const max = Number.isFinite(parsed) ? Math.min(999, Math.max(1, parsed)) : DEFAULT_MAX;
    maxNumberInput.value = String(max);

    if (!allowDuplicatesInput.checked && max < REEL_COUNT) {
      if (showError) showToast(`중복 없이 ${REEL_COUNT}개를 뽑으려면 최대 번호가 ${REEL_COUNT} 이상이어야 합니다.`);
      return null;
    }

    return max;
  }

  function drawNumbers(count, max, allowDuplicates) {
    if (allowDuplicates) {
      return Array.from({ length: count }, () => secureRandomInt(1, max));
    }

    const pool = Array.from({ length: max }, (_, i) => i + 1);
    for (let i = 0; i < count; i++) {
      const j = secureRandomInt(i, pool.length - 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    return pool.slice(0, count);
  }

  function secureRandomInt(min, max) {
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
  }

  function randomFloat(min, max) {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return min + (buffer[0] / 0xffffffff) * (max - min);
  }

  function renderHistory() {
    historyList.textContent = "";
    emptyHistory.hidden = history.length > 0;
    copyAllButton.disabled = history.length === 0;
    clearHistoryButton.disabled = history.length === 0;

    history.forEach((record, index) => {
      const li = document.createElement("li");
      li.className = "history-item";

      const order = document.createElement("span");
      order.className = "history-index";
      order.textContent = `#${history.length - index}`;

      const values = document.createElement("span");
      values.className = "history-values";
      values.textContent = formatRecordNumbers(record);

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost-button history-copy";
      copy.textContent = "복사";
      copy.addEventListener("click", (event) => {
        event.stopPropagation();
        copyText(formatRecordNumbers(record), "해당 번호를 복사했습니다.");
      });

      li.append(order, values, copy);
      historyList.append(li);
    });
  }

  function setResultPlaceholders() {
    [...resultNumbers.children].forEach((cell) => {
      cell.textContent = "—";
      cell.classList.remove("pop");
    });
  }

  function formatDisplayNumber(value, max) {
    if (!Number.isFinite(value)) return "—";
    const width = Math.max(1, String(Math.max(1, max || DEFAULT_MAX)).length);
    return String(value).padStart(width, "0");
  }

  function formatRecordNumbers(record) {
    const max = Number.isFinite(record.max) ? record.max : DEFAULT_MAX;
    return record.numbers.map((value) => formatDisplayNumber(value, max)).join("  ");
  }

  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((record) => record && Array.isArray(record.numbers) && record.numbers.length === REEL_COUNT)
        .map((record) => ({
          max: Number.isFinite(record.max) ? record.max : DEFAULT_MAX,
          allowDuplicates: Boolean(record.allowDuplicates),
          numbers: record.numbers.map(Number)
        }))
        .slice(0, 200);
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      showToast("브라우저 저장소에 기록을 저장하지 못했습니다.");
    }
  }

  async function copyText(text, message) {
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      showToast(message);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      showToast(message);
    }
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1800);
  }

  function modulo(value, mod) {
    return ((value % mod) + mod) % mod;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function easeOutQuint(t) {
    return 1 - Math.pow(1 - t, 5);
  }

  stage.addEventListener("click", toggleDraw);

  stage.addEventListener("keydown", (event) => {
    if (event.code === "Enter") {
      event.preventDefault();
      toggleDraw();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space") return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;

    event.preventDefault();
    toggleDraw();
  });

  copyCurrentButton.addEventListener("click", () => {
    if (!currentResult.length) return;
    const max = getMaxNumber(false);
    copyText(currentResult.map((n) => formatDisplayNumber(n, max)).join("  "), "이번 추첨 번호를 복사했습니다.");
  });

  copyAllButton.addEventListener("click", () => {
    if (!history.length) return;
    copyText(history.map(formatRecordNumbers).join("\n"), "전체 추첨 번호를 복사했습니다.");
  });

  clearHistoryButton.addEventListener("click", () => {
    if (!history.length) return;
    if (!window.confirm("추첨 기록을 모두 초기화할까요?")) return;

    history = [];
    saveHistory();
    renderHistory();
    showToast("추첨 기록을 초기화했습니다.");
  });

  maxNumberInput.addEventListener("change", () => getMaxNumber(false));

  renderHistory();
  requestAnimationFrame(animate);
})();
