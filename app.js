(() => {
  "use strict";

  const MAX_REELS = 7;
  const HISTORY_STORAGE_KEY = "lucky-mouth-roulette.history.v1";
  const SETTINGS_STORAGE_KEY = "mya-lotto.settings.v1";
  const DEFAULT_MAX = 45;
  const DEFAULT_COUNT = 7;

  const canvas = document.getElementById("teethCanvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("characterStage");
  const stageStatus = document.getElementById("stageStatus");
  const maxNumberInput = document.getElementById("maxNumber");
  const drawCountInput = document.getElementById("drawCount");
  const resultNumbers = document.getElementById("resultNumbers");
  const copyCurrentButton = document.getElementById("copyCurrentButton");
  const copyAllButton = document.getElementById("copyAllButton");
  const clearHistoryButton = document.getElementById("clearHistoryButton");
  const historyList = document.getElementById("historyList");
  const emptyHistory = document.getElementById("emptyHistory");
  const toast = document.getElementById("toast");

  const savedSettings = loadSettings();
  maxNumberInput.value = String(savedSettings.max);
  drawCountInput.value = String(savedSettings.count);

  let appState = "idle";
  let currentResult = [];
  let history = loadHistory();
  let previousFrameTime = performance.now();
  let toastTimer = 0;
  let visibleReelCount = savedSettings.count;
  let activeReels = Array.from({ length: visibleReelCount }, (_, i) => i);

  class ToothReel {
    constructor(index) {
      this.index = index;
      this.position = index * 2.31;
      this.speed = 26 + index * 0.9;
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

    reset() {
      this.position = this.index * 2.31;
      this.speed = 26 + this.index * 0.9;
      this.mode = "idle";
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
      this.position = randomFloat(0, 80) + this.index * 0.37;
      this.speed = randomFloat(27, 36) + this.index * 0.75;
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
      this.stopFrom = this.position;
      this.stopTo = Math.ceil(this.position) + 15 + this.index * 2 + secureRandomInt(0, 5);
      this.stopDuration = duration;
      this.stopNotified = false;
    }

    update(dt, now) {
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.4);

      if (this.mode === "spinning") {
        this.position += this.speed * dt;
        return false;
      }

      if (this.mode === "stopping") {
        const t = Math.min(1, (now - this.stopStart) / this.stopDuration);
        this.position = lerp(this.stopFrom, this.stopTo, easeOutQuint(t));

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
      if (this.target != null && Math.round(step) === Math.round(this.stopTo)) {
        return this.target;
      }

      if (this.mode === "stopped" && this.target != null) {
        return this.target;
      }

      let x = (step + 1) * 0x45d9f3b + (this.index + 11) * 0x27d4eb2d;
      x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
      x ^= x >>> 16;
      return modulo(Math.abs(x), this.max) + 1;
    }
  }

  const reels = Array.from({ length: MAX_REELS }, (_, i) => new ToothReel(i));

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

  function fillToothFace(path, faceHeight, value, max, alpha = 1) {
    const g = ctx.createLinearGradient(0, -faceHeight / 2, 0, faceHeight / 2);
    g.addColorStop(0, "rgba(255,255,250,.98)");
    g.addColorStop(0.48, "rgba(255,245,231,.99)");
    g.addColorStop(1, "rgba(228,198,177,.98)");

    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.shadowColor = "rgba(83, 18, 8, .36)";
    ctx.shadowBlur = Math.max(1, faceHeight * 0.055);
    ctx.fill(path);

    ctx.lineWidth = Math.max(0.35, faceHeight * 0.018);
    ctx.strokeStyle = "rgba(125, 61, 39, .28)";
    ctx.stroke(path);

    if (value != null) {
      ctx.fillStyle = "#7d2d18";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `900 ${Math.min(faceHeight * 0.47, 19)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.shadowColor = "rgba(255,255,255,.6)";
      ctx.shadowBlur = 1;
      ctx.fillText(formatDisplayNumber(value, max), 0, 0);
    }

    ctx.globalAlpha = 1;
  }

  function renderTeeth() {
    const { dpr, width: w, height: h } = resizeCanvas();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const clip = mouthClipPath(w, h);
    ctx.save();
    ctx.clip(clip);

    const count = Math.max(1, Math.min(MAX_REELS, visibleReelCount));
    const centerLeft = w * 0.08;
    const centerRight = w * 0.92;
    const normalSlotW = (w * 0.95) / MAX_REELS;
    const baseW = normalSlotW * 0.91;
    const baseH = h * 0.90;
    const centerY = h * 0.48;
    const rowStep = baseH * 0.84;
    const faceH = baseH * 0.80;

    for (let i = 0; i < count; i++) {
      const reel = reels[i];
      const x = count === 1
        ? w * 0.5
        : lerp(centerLeft, centerRight, i / (count - 1));
      const arch = Math.abs(i - (count - 1) / 2) * h * 0.012;
      const y = centerY + arch;
      const outerTooth = toothPath(baseW, baseH);

      ctx.save();
      ctx.translate(x, y);
      ctx.clip(outerTooth);

      ctx.fillStyle = "rgba(30, 5, 6, .92)";
      ctx.fillRect(-baseW, -baseH, baseW * 2, baseH * 2);

      if (reel.mode === "idle") {
        const face = toothPath(baseW * 0.96, faceH);
        fillToothFace(face, faceH, null, reel.max);
      } else {
        const base = Math.floor(reel.position);
        const frac = reel.position - base;

        for (let offset = -2; offset <= 2; offset++) {
          const step = base + offset;
          const faceY = (offset - frac) * rowStep;
          const distance = Math.abs(faceY / rowStep);
          const alpha = Math.max(0.34, 1 - distance * 0.23);
          const value = reel.visualValue(step);

          ctx.save();
          ctx.translate(0, faceY);
          const face = toothPath(baseW * 0.96, faceH);
          fillToothFace(face, faceH, value, reel.max, alpha);
          ctx.restore();
        }
      }

      const topShade = ctx.createLinearGradient(0, -baseH / 2, 0, -baseH * 0.05);
      topShade.addColorStop(0, "rgba(45, 6, 8, .72)");
      topShade.addColorStop(1, "rgba(45, 6, 8, 0)");
      ctx.fillStyle = topShade;
      ctx.fillRect(-baseW / 2, -baseH / 2, baseW, baseH * 0.46);

      const bottomShade = ctx.createLinearGradient(0, baseH * 0.05, 0, baseH / 2);
      bottomShade.addColorStop(0, "rgba(45, 6, 8, 0)");
      bottomShade.addColorStop(1, "rgba(45, 6, 8, .64)");
      ctx.fillStyle = bottomShade;
      ctx.fillRect(-baseW / 2, baseH * 0.05, baseW, baseH * 0.45);

      ctx.restore();

      ctx.save();
      ctx.translate(x, y);
      ctx.lineWidth = Math.max(0.45, w * 0.0018);
      ctx.strokeStyle = "rgba(125, 61, 39, .38)";
      ctx.stroke(outerTooth);
      ctx.restore();

      if (reel.flash > 0) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, normalSlotW * 0.95);
        glow.addColorStop(0, `rgba(255, 243, 179, ${0.72 * reel.flash})`);
        glow.addColorStop(1, "rgba(255, 173, 44, 0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x - normalSlotW, 0, normalSlotW * 2, h);
      }
    }

    ctx.restore();
  }

  function animate(now) {
    const dt = Math.min(0.05, (now - previousFrameTime) / 1000);
    previousFrameTime = now;

    activeReels.forEach((index) => {
      if (reels[index].update(dt, now)) {
        onReelStopped(index);
      }
    });

    renderTeeth();

    if (
      appState === "stopping" &&
      activeReels.length > 0 &&
      activeReels.every((index) => reels[index].mode === "stopped")
    ) {
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

    const settings = getValidatedSettings(true);
    if (!settings) return;

    visibleReelCount = settings.count;
    activeReels = Array.from({ length: settings.count }, (_, i) => i);
    appState = "spinning";
    currentResult = [];
    stage.classList.remove("final-win");
    buildResultCells(settings.count);
    setResultPlaceholders();

    reels.forEach((reel) => reel.reset());
    activeReels.forEach((index) => reels[index].start(settings.max));

    setSettingsDisabled(true);
    copyCurrentButton.disabled = true;
    stageStatus.textContent = `${settings.count}개의 이빨 릴 회전 중 · 다시 클릭하거나 Space로 정지`;
  }

  function stopSpin() {
    if (appState !== "spinning") return;

    const settings = getValidatedSettings(true);
    if (!settings) return;

    currentResult = drawUniqueNumbers(settings.count, settings.max);
    appState = "stopping";
    stageStatus.textContent = "왼쪽 릴부터 하나씩 정지 중…";

    activeReels.forEach((reelIndex, resultIndex) => {
      const isLast = resultIndex === activeReels.length - 1;
      const delay = resultIndex * 280 + (isLast ? 620 : 0);
      const duration = 900 + resultIndex * 45 + (isLast ? 260 : 0);
      const target = currentResult[resultIndex];

      window.setTimeout(() => {
        reels[reelIndex].beginStop(target, performance.now(), duration);
      }, delay);
    });
  }

  function onReelStopped(reelIndex) {
    const resultIndex = activeReels.indexOf(reelIndex);
    if (resultIndex < 0) return;

    const cell = resultNumbers.children[resultIndex];
    if (cell) {
      cell.textContent = formatDisplayNumber(currentResult[resultIndex], getMaxNumber());
      cell.classList.remove("pop");
      void cell.offsetWidth;
      cell.classList.add("pop");
    }

    stageStatus.textContent = resultIndex < activeReels.length - 1
      ? `${resultIndex + 1} / ${activeReels.length} 정지 · 다음 릴 감속 중…`
      : "마지막 번호 확정!";
  }

  function finalizeDraw() {
    if (appState !== "stopping") return;

    appState = "result";
    setSettingsDisabled(false);
    copyCurrentButton.disabled = false;

    stage.classList.add("final-win");
    window.setTimeout(() => stage.classList.remove("final-win"), 1000);

    const record = {
      max: getMaxNumber(),
      numbers: currentResult.slice()
    };

    history.unshift(record);
    history = history.slice(0, 200);
    saveHistory();
    renderHistory();

    stageStatus.textContent = `완료 · ${formatRecordNumbers(record)}`;
  }

  function drawUniqueNumbers(count, max) {
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

  function getMaxNumber() {
    const parsed = Number.parseInt(maxNumberInput.value, 10);
    return Number.isFinite(parsed) ? Math.min(999, Math.max(1, parsed)) : DEFAULT_MAX;
  }

  function getDrawCount() {
    const parsed = Number.parseInt(drawCountInput.value, 10);
    return Number.isFinite(parsed) ? Math.min(MAX_REELS, Math.max(1, parsed)) : DEFAULT_COUNT;
  }

  function getValidatedSettings(showError) {
    const max = getMaxNumber();
    const count = getDrawCount();

    maxNumberInput.value = String(max);
    drawCountInput.value = String(count);

    if (max < count) {
      if (showError) {
        showToast(`중복 없이 ${count}개를 뽑으려면 번호 범위가 최소 ${count}까지 필요합니다.`);
      }
      return null;
    }

    return { max, count };
  }

  function normalizeAndSaveSettings(changedField) {
    let max = getMaxNumber();
    let count = getDrawCount();

    if (max < count) {
      if (changedField === "max") {
        max = count;
        showToast(`번호 범위를 ${count}까지로 조정했습니다.`);
      } else {
        max = count;
        showToast(`번호 범위를 ${count}까지로 함께 늘렸습니다.`);
      }
    }

    maxNumberInput.value = String(max);
    drawCountInput.value = String(count);
    visibleReelCount = count;
    activeReels = Array.from({ length: count }, (_, i) => i);
    saveSettings({ max, count });

    if (appState !== "spinning" && appState !== "stopping") {
      appState = "idle";
      currentResult = [];
      reels.forEach((reel) => reel.reset());
      buildResultCells(count);
      setResultPlaceholders();
      copyCurrentButton.disabled = true;
      stageStatus.textContent = "이미지 클릭 또는 Space 키로 시작";
    }
  }

  function setSettingsDisabled(disabled) {
    maxNumberInput.disabled = disabled;
    drawCountInput.disabled = disabled;
  }

  function buildResultCells(count) {
    resultNumbers.textContent = "";
    for (let i = 0; i < count; i++) {
      const cell = document.createElement("span");
      cell.textContent = "—";
      resultNumbers.appendChild(cell);
    }
  }

  function setResultPlaceholders() {
    [...resultNumbers.children].forEach((cell) => {
      cell.textContent = "—";
      cell.classList.remove("pop");
    });
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

  function formatDisplayNumber(value, max) {
    if (!Number.isFinite(value)) return "—";
    const width = Math.max(1, String(Math.max(1, max || DEFAULT_MAX)).length);
    return String(value).padStart(width, "0");
  }

  function formatRecordNumbers(record) {
    const max = Number.isFinite(record.max) ? record.max : DEFAULT_MAX;
    return record.numbers.map((value) => formatDisplayNumber(value, max)).join("  ");
  }

  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") {
        return { max: DEFAULT_MAX, count: DEFAULT_COUNT };
      }

      let max = Number.parseInt(parsed.max, 10);
      let count = Number.parseInt(parsed.count, 10);
      max = Number.isFinite(max) ? Math.min(999, Math.max(1, max)) : DEFAULT_MAX;
      count = Number.isFinite(count) ? Math.min(MAX_REELS, Math.max(1, count)) : DEFAULT_COUNT;
      if (max < count) max = count;
      return { max, count };
    } catch {
      return { max: DEFAULT_MAX, count: DEFAULT_COUNT };
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      showToast("설정값을 브라우저에 저장하지 못했습니다.");
    }
  }

  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((record) => (
          record &&
          Array.isArray(record.numbers) &&
          record.numbers.length >= 1 &&
          record.numbers.length <= MAX_REELS
        ))
        .map((record) => ({
          max: Number.isFinite(record.max) ? record.max : DEFAULT_MAX,
          numbers: record.numbers.map(Number)
        }))
        .slice(0, 200);
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
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
    if (event.code !== "Enter" || event.repeat) return;
    event.preventDefault();
    toggleDraw();
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLElement && event.target.isContentEditable) return;

    event.preventDefault();
    event.stopPropagation();
    toggleDraw();
  }, true);

  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space") return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  copyCurrentButton.addEventListener("click", () => {
    if (!currentResult.length) return;
    const record = { max: getMaxNumber(), numbers: currentResult };
    copyText(formatRecordNumbers(record), "이번 추첨 번호를 복사했습니다.");
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

  maxNumberInput.addEventListener("change", () => normalizeAndSaveSettings("max"));
  drawCountInput.addEventListener("change", () => normalizeAndSaveSettings("count"));

  saveSettings(savedSettings);
  buildResultCells(savedSettings.count);
  renderHistory();
  requestAnimationFrame(animate);
})();
