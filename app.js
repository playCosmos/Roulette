(() => {
  "use strict";

  const REEL_COUNT = 7;
  const STORAGE_KEY = "lucky-mouth-roulette.history.v1";
  const DEFAULT_MAX = 45;

  const canvas = document.getElementById("reelCanvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("characterStage");
  const stageStatus = document.getElementById("stageStatus");
  const spinButton = document.getElementById("spinButton");
  const stopButton = document.getElementById("stopButton");
  const maxNumberInput = document.getElementById("maxNumber");
  const allowDuplicatesInput = document.getElementById("allowDuplicates");
  const soundToggle = document.getElementById("soundToggle");
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
  let animationFrame = 0;
  let previousFrameTime = performance.now();
  let soundEnabled = true;
  let audioContext = null;
  let toastTimer = 0;

  class Reel {
    constructor(index) {
      this.index = index;
      this.position = index * 4.67;
      this.speed = 18 + index * 1.15;
      this.mode = "idle";
      this.stopStart = 0;
      this.stopFrom = 0;
      this.stopTo = 0;
      this.stopDuration = 0;
      this.target = null;
      this.flash = 0;
      this.stopNotified = false;
    }

    start(max) {
      this.position = randomFloat(0, Math.max(1, max));
      this.speed = randomFloat(19, 28) + this.index * 0.45;
      this.mode = "spinning";
      this.target = null;
      this.flash = 0;
      this.stopNotified = false;
    }

    beginStop(target, max, now, duration) {
      if (this.mode !== "spinning") return;
      const current = this.position;
      const currentMod = modulo(current, max);
      const targetIndex = target - 1;
      let delta = modulo(targetIndex - currentMod, max);
      delta += (2 + (this.index % 2)) * max;

      this.mode = "stopping";
      this.stopStart = now;
      this.stopFrom = current;
      this.stopTo = current + delta;
      this.stopDuration = duration;
      this.target = target;
      this.stopNotified = false;
    }

    update(dt, now) {
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.3);

      if (this.mode === "spinning") {
        this.position += this.speed * dt;
        return false;
      }

      if (this.mode === "stopping") {
        const t = Math.min(1, (now - this.stopStart) / this.stopDuration);
        const eased = easeOutQuint(t);
        this.position = lerp(this.stopFrom, this.stopTo, eased);
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
  }

  const reels = Array.from({ length: REEL_COUNT }, (_, i) => new Reel(i));

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function renderReels() {
    resizeCanvas();
    const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    const w = canvas.width;
    const h = canvas.height;
    const max = getMaxNumber(false);

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(dpr, dpr);

    const cssW = w / dpr;
    const cssH = h / dpr;
    const colW = cssW / REEL_COUNT;
    const rowH = cssH * 0.70;
    const centerY = cssH * 0.50;
    const centerFont = Math.max(8, Math.min(colW * 0.58, cssH * 0.44));
    const neighborFont = centerFont * 0.66;

    for (let i = 0; i < REEL_COUNT; i++) {
      const reel = reels[i];
      const x = i * colW;
      const base = Math.floor(reel.position);
      const frac = reel.position - base;

      if (i > 0) {
        ctx.strokeStyle = "rgba(255, 189, 83, 0.17)";
        ctx.lineWidth = Math.max(0.6, cssW * 0.002);
        ctx.beginPath();
        ctx.moveTo(x, cssH * 0.16);
        ctx.lineTo(x, cssH * 0.84);
        ctx.stroke();
      }

      for (let offset = -2; offset <= 2; offset++) {
        const idx = base + offset;
        const value = modulo(idx, max) + 1;
        const y = centerY + (offset - frac) * rowH;
        const dist = Math.abs((y - centerY) / rowH);
        const isCenter = dist < 0.52;
        const alpha = Math.max(0, 1 - dist * 0.58);
        if (alpha <= 0.04) continue;

        ctx.save();
        ctx.globalAlpha = isCenter ? alpha : alpha * 0.48;
        ctx.fillStyle = isCenter ? "#ffe29a" : "#b8773f";
        ctx.shadowColor = isCenter ? "rgba(255, 165, 38, 0.75)" : "transparent";
        ctx.shadowBlur = isCenter ? Math.max(2, cssH * 0.09) : 0;
        ctx.font = `700 ${isCenter ? centerFont : neighborFont}px "Roboto Mono", ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(value).padStart(2, "0"), x + colW / 2, y);
        ctx.restore();
      }

      if (reel.flash > 0) {
        const grad = ctx.createRadialGradient(x + colW / 2, centerY, 0, x + colW / 2, centerY, colW * 0.9);
        grad.addColorStop(0, `rgba(255, 226, 126, ${0.54 * reel.flash})`);
        grad.addColorStop(1, "rgba(255, 160, 35, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(x, 0, colW, cssH);
      }
    }

    const topShade = ctx.createLinearGradient(0, 0, 0, cssH * 0.34);
    topShade.addColorStop(0, "rgba(0,0,0,.76)");
    topShade.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = topShade;
    ctx.fillRect(0, 0, cssW, cssH * 0.35);

    const bottomShade = ctx.createLinearGradient(0, cssH * 0.65, 0, cssH);
    bottomShade.addColorStop(0, "rgba(0,0,0,0)");
    bottomShade.addColorStop(1, "rgba(0,0,0,.78)");
    ctx.fillStyle = bottomShade;
    ctx.fillRect(0, cssH * 0.65, cssW, cssH * 0.35);
    ctx.restore();
  }

  function animate(now) {
    const dt = Math.min(0.05, (now - previousFrameTime) / 1000);
    previousFrameTime = now;

    let newlyStopped = false;
    reels.forEach((reel) => {
      if (reel.update(dt, now)) {
        newlyStopped = true;
        onReelStopped(reel.index);
      }
    });

    renderReels();

    if (newlyStopped && reels.every((reel) => reel.mode === "stopped")) {
      finalizeDraw();
    }

    animationFrame = requestAnimationFrame(animate);
  }

  function startSpin() {
    if (appState === "spinning" || appState === "stopping") return;
    const max = getMaxNumber(true);
    if (max === null) return;

    unlockAudio();
    appState = "spinning";
    currentResult = [];
    stage.classList.remove("final-win");
    setResultPlaceholders();
    reels.forEach((reel) => reel.start(max));

    spinButton.disabled = true;
    stopButton.disabled = false;
    maxNumberInput.disabled = true;
    allowDuplicatesInput.disabled = true;
    copyCurrentButton.disabled = true;
    stageStatus.textContent = "7개 릴 회전 중 · STOP을 누르세요";
    playSpinCue();
  }

  function stopSpin() {
    if (appState !== "spinning") return;
    const max = getMaxNumber(true);
    if (max === null) return;

    const targets = drawNumbers(REEL_COUNT, max, allowDuplicatesInput.checked);
    currentResult = targets.slice();
    appState = "stopping";
    stopButton.disabled = true;
    stageStatus.textContent = "왼쪽부터 하나씩 정지 중…";

    targets.forEach((target, i) => {
      const delay = i * 285 + (i === REEL_COUNT - 1 ? 620 : 0);
      const duration = 820 + i * 35 + (i === REEL_COUNT - 1 ? 260 : 0);
      window.setTimeout(() => {
        reels[i].beginStop(target, max, performance.now(), duration);
      }, delay);
    });
  }

  function onReelStopped(index) {
    playStopCue(index);
    const target = currentResult[index];
    const cells = resultNumbers.children;
    if (cells[index]) {
      cells[index].textContent = formatNumber(target);
      cells[index].classList.remove("pop");
      void cells[index].offsetWidth;
      cells[index].classList.add("pop");
    }

    stageStatus.textContent = index < REEL_COUNT - 1
      ? `${index + 1} / ${REEL_COUNT} 정지 · 다음 릴 감속 중…`
      : "마지막 번호 확정!";
  }

  function finalizeDraw() {
    if (appState !== "stopping") return;
    appState = "result";
    spinButton.disabled = false;
    maxNumberInput.disabled = false;
    allowDuplicatesInput.disabled = false;
    copyCurrentButton.disabled = false;
    stage.classList.add("final-win");
    window.setTimeout(() => stage.classList.remove("final-win"), 1000);

    const record = {
      id: cryptoRandomId(),
      timestamp: new Date().toISOString(),
      max: getMaxNumber(false),
      allowDuplicates: allowDuplicatesInput.checked,
      numbers: currentResult.slice()
    };

    history.unshift(record);
    history = history.slice(0, 200);
    saveHistory();
    renderHistory();
    playFinalCue();
    stageStatus.textContent = `완료 · ${currentResult.map(formatNumber).join("  ")}`;
  }

  function getMaxNumber(showError) {
    const raw = Number.parseInt(maxNumberInput.value, 10);
    const max = Number.isFinite(raw) ? Math.min(999, Math.max(1, raw)) : DEFAULT_MAX;
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

  function cryptoRandomId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${secureRandomInt(100000, 999999)}`;
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

      const main = document.createElement("div");
      main.className = "history-main";

      const values = document.createElement("span");
      values.className = "history-values";
      values.textContent = record.numbers.map(formatNumber).join("  ·  ");

      const time = document.createElement("span");
      time.className = "history-time";
      time.textContent = formatTimestamp(record.timestamp);
      main.append(values, time);

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost-button history-copy";
      copy.textContent = "복사";
      copy.addEventListener("click", () => copyText(formatRecordForCopy(record), "해당 기록을 복사했습니다."));

      li.append(order, main, copy);
      historyList.append(li);
    });
  }

  function setResultPlaceholders() {
    [...resultNumbers.children].forEach((cell) => {
      cell.textContent = "—";
      cell.classList.remove("pop");
    });
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "—";
    const width = getMaxNumber(false) >= 10 ? 2 : 1;
    return String(value).padStart(width, "0");
  }

  function formatTimestamp(iso) {
    const date = new Date(iso);
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(date);
  }

  function formatRecordForCopy(record) {
    return record.numbers.map((n) => String(n).padStart(record.max >= 10 ? 2 : 1, "0")).join(", ");
  }

  function formatAllHistory() {
    return history
      .map((record, index) => `${history.length - index}. ${formatTimestamp(record.timestamp)} | ${formatRecordForCopy(record)}`)
      .join("\n");
  }

  async function copyText(text, successMessage) {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      showToast(successMessage);
    } catch {
      showToast("복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
    }
  }

  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed)
        ? parsed.filter((item) => item && Array.isArray(item.numbers) && item.numbers.length === REEL_COUNT)
        : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      showToast("기록 저장 공간을 사용할 수 없습니다.");
    }
  }

  function clearHistory() {
    if (history.length === 0) return;
    if (!window.confirm("저장된 추첨 기록을 모두 삭제할까요?")) return;
    history = [];
    saveHistory();
    renderHistory();
    showToast("추첨 기록을 초기화했습니다.");
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1900);
  }

  function unlockAudio() {
    if (!soundEnabled) return;
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioContext = new AudioCtx();
    }
    if (audioContext?.state === "suspended") audioContext.resume().catch(() => {});
  }

  function tone(frequency, duration = 0.06, gain = 0.035, type = "sine", delay = 0) {
    if (!soundEnabled || !audioContext) return;
    const start = audioContext.currentTime + delay;
    const osc = audioContext.createOscillator();
    const amp = audioContext.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(amp).connect(audioContext.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function playSpinCue() {
    tone(220, 0.05, 0.02, "triangle");
    tone(330, 0.07, 0.02, "triangle", 0.045);
  }

  function playStopCue(index) {
    tone(390 + index * 42, 0.07, 0.035, "square");
    tone(710 + index * 28, 0.10, 0.022, "sine", 0.035);
  }

  function playFinalCue() {
    [523.25, 659.25, 783.99].forEach((f, i) => tone(f, 0.22, 0.03, "sine", i * 0.08));
  }

  function modulo(value, divisor) { return ((value % divisor) + divisor) % divisor; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }

  spinButton.addEventListener("click", startSpin);
  stopButton.addEventListener("click", stopSpin);
  maxNumberInput.addEventListener("change", () => getMaxNumber(true));
  allowDuplicatesInput.addEventListener("change", () => getMaxNumber(true));

  copyCurrentButton.addEventListener("click", () => {
    if (currentResult.length === REEL_COUNT) {
      copyText(currentResult.map(formatNumber).join(", "), "이번 추첨 번호를 복사했습니다.");
    }
  });

  copyAllButton.addEventListener("click", () => {
    if (history.length) copyText(formatAllHistory(), "전체 추첨 기록을 복사했습니다.");
  });

  clearHistoryButton.addEventListener("click", clearHistory);

  soundToggle.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    soundToggle.textContent = soundEnabled ? "🔊" : "🔇";
    soundToggle.setAttribute("aria-pressed", String(soundEnabled));
    if (soundEnabled) unlockAudio();
  });

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return;
    event.preventDefault();
    if (appState === "spinning") stopSpin();
    else if (appState !== "stopping") startSpin();
  });

  window.addEventListener("resize", resizeCanvas, { passive: true });

  renderHistory();
  setResultPlaceholders();
  resizeCanvas();
  cancelAnimationFrame(animationFrame);
  animationFrame = requestAnimationFrame((now) => {
    previousFrameTime = now;
    animate(now);
  });
})();
