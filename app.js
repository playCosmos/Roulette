(() => {
  "use strict";

  const REEL_COUNT = 7;
  const STORAGE_KEY = "lucky-teeth-roulette.history.v2";
  const DEFAULT_MAX = 45;

  const canvas = document.getElementById("teethCanvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("characterStage");
  const image = document.getElementById("characterImage");
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
  let previousFrameTime = performance.now();
  let soundEnabled = true;
  let audioContext = null;
  let toastTimer = 0;

  class ToothReel {
    constructor(index) {
      this.index = index;
      this.phase = index * 1.23;
      this.speed = 0;
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
      this.phase = secureRandomInt(0, Math.max(0, max - 1)) + randomFloat(0, 0.95);
      this.speed = randomFloat(18, 24) + this.index * 0.55;
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
      this.stopDuration = duration;
      this.stopNotified = false;

      // 실제 회전 위상을 목표 번호에 맞춰서 정지시킨다.
      const firstWholeFace = Math.ceil(this.phase);
      const targetIndex = target - 1;
      const firstIndex = modulo(firstWholeFace, this.max);
      const targetDelta = modulo(targetIndex - firstIndex, this.max);
      const extraTurns = 2 + (this.index % 2);
      this.stopTo = firstWholeFace + targetDelta + extraTurns * this.max;
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

    valueAt(step) {
      return modulo(step, this.max) + 1;
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
    return dpr;
  }

  function mouthPath(w, h) {
    const p = new Path2D();
    p.moveTo(w * 0.04, h * 0.23);
    p.bezierCurveTo(w * 0.18, h * 0.03, w * 0.82, h * 0.03, w * 0.96, h * 0.23);
    p.bezierCurveTo(w * 0.99, h * 0.46, w * 0.89, h * 0.82, w * 0.73, h * 0.91);
    p.bezierCurveTo(w * 0.54, h * 0.99, w * 0.28, h * 0.96, w * 0.11, h * 0.82);
    p.bezierCurveTo(w * 0.02, h * 0.70, w * 0.005, h * 0.40, w * 0.04, h * 0.23);
    p.closePath();
    return p;
  }

  function toothPath(width, height) {
    const p = new Path2D();
    const corner = Math.min(width, height) * 0.18;
    const taper = width * 0.065;

    p.moveTo(-width / 2 + corner, -height / 2);
    p.quadraticCurveTo(-width / 2, -height / 2, -width / 2, -height / 2 + corner);
    p.lineTo(-width / 2 + taper, height / 2 - corner);
    p.quadraticCurveTo(-width / 2 + taper, height / 2, -width / 2 + taper + corner, height / 2);
    p.lineTo(width / 2 - taper - corner, height / 2);
    p.quadraticCurveTo(width / 2 - taper, height / 2, width / 2 - taper, height / 2 - corner);
    p.lineTo(width / 2, -height / 2 + corner);
    p.quadraticCurveTo(width / 2, -height / 2, width / 2 - corner, -height / 2);
    p.closePath();
    return p;
  }

  function renderToothFace(reel, x, y, width, height, step, scaleY, angle, spinning) {
    ctx.save();
    ctx.translate(x, y + Math.sin(angle) * height * 0.055);
    ctx.scale(1, Math.max(0.045, scaleY));

    const tooth = toothPath(width, height);
    const facing = Math.max(0, scaleY);
    const enamel = ctx.createLinearGradient(0, -height / 2, 0, height / 2);
    enamel.addColorStop(0, `rgba(255,255,252,${0.88 + facing * 0.12})`);
    enamel.addColorStop(0.48, `rgba(255,247,232,${0.86 + facing * 0.14})`);
    enamel.addColorStop(1, `rgba(218,181,154,${0.90 + facing * 0.10})`);

    ctx.fillStyle = enamel;
    ctx.shadowColor = "rgba(63, 14, 7, .52)";
    ctx.shadowBlur = height * 0.075;
    ctx.fill(tooth);

    ctx.lineWidth = Math.max(0.5, width * 0.025);
    ctx.strokeStyle = "rgba(123, 63, 38, .38)";
    ctx.stroke(tooth);

    if (scaleY > 0.16 && reel.mode !== "idle") {
      const value = reel.valueAt(step);
      const textAlpha = clamp((scaleY - 0.12) / 0.45, 0, 1);
      ctx.globalAlpha = textAlpha;
      ctx.fillStyle = "#8d2b18";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `900 ${Math.min(width * 0.67, height * 0.54)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.shadowColor = "rgba(255,255,255,.52)";
      ctx.shadowBlur = 1.2;
      ctx.fillText(formatNumber(value), 0, 0);
    }

    if (spinning && scaleY > 0.20) {
      ctx.globalAlpha = 0.11 * scaleY;
      ctx.fillStyle = "#8f2618";
      for (let i = -1; i <= 1; i++) {
        ctx.fillRect(-width * 0.23, i * height * 0.18 - 0.4, width * 0.46, 0.8);
      }
    }

    ctx.restore();
  }

  function renderTeeth() {
    const dpr = resizeCanvas();
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cavity = mouthPath(w, h);
    const cavityGradient = ctx.createLinearGradient(0, 0, 0, h);
    cavityGradient.addColorStop(0, "rgba(55, 5, 8, .99)");
    cavityGradient.addColorStop(0.58, "rgba(15, 1, 4, .995)");
    cavityGradient.addColorStop(1, "rgba(65, 6, 10, .99)");
    ctx.fillStyle = cavityGradient;
    ctx.fill(cavity);

    ctx.save();
    ctx.clip(cavity);

    const left = w * 0.075;
    const right = w * 0.925;
    const slotW = (right - left) / REEL_COUNT;
    const baseW = slotW * 0.93;
    const baseH = h * 0.73;
    const centerY = h * 0.48;

    for (let i = 0; i < REEL_COUNT; i++) {
      const reel = reels[i];
      const lower = Math.floor(reel.phase);
      const progress = reel.phase - lower;
      const angle = progress * Math.PI;
      const showingNext = progress >= 0.5;
      const step = showingNext ? lower + 1 : lower;
      const scaleY = Math.abs(Math.cos(angle));
      const x = left + slotW * (i + 0.5);
      const arch = Math.abs(i - 3) * h * 0.013;
      const y = centerY + arch;

      renderToothFace(
        reel,
        x,
        y,
        baseW,
        baseH,
        step,
        scaleY,
        angle,
        reel.mode === "spinning" || reel.mode === "stopping"
      );

      if (reel.flash > 0) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, slotW * 1.25);
        glow.addColorStop(0, `rgba(255,242,171,${0.72 * reel.flash})`);
        glow.addColorStop(1, "rgba(255,176,52,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x - slotW * 1.3, 0, slotW * 2.6, h);
      }
    }

    const topShade = ctx.createLinearGradient(0, 0, 0, h * 0.34);
    topShade.addColorStop(0, "rgba(27,0,2,.67)");
    topShade.addColorStop(1, "rgba(27,0,2,0)");
    ctx.fillStyle = topShade;
    ctx.fillRect(0, 0, w, h * 0.34);

    const bottomShade = ctx.createLinearGradient(0, h * 0.68, 0, h);
    bottomShade.addColorStop(0, "rgba(40,0,2,0)");
    bottomShade.addColorStop(1, "rgba(40,0,2,.42)");
    ctx.fillStyle = bottomShade;
    ctx.fillRect(0, h * 0.68, w, h * 0.32);

    ctx.restore();

    ctx.lineWidth = Math.max(0.65, w * 0.0035);
    ctx.strokeStyle = "rgba(115,28,18,.72)";
    ctx.stroke(cavity);
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

  function startSpin() {
    if (appState === "spinning" || appState === "stopping") return;
    const max = getMaxNumber(true);
    if (max == null) return;

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
    stageStatus.textContent = "7개의 이빨이 회전 중 · STOP을 누르세요";
    playCue(220, 0.045, "sine", 0.025);
  }

  function stopSpin() {
    if (appState !== "spinning") return;
    const max = getMaxNumber(true);
    if (max == null) return;

    currentResult = drawNumbers(REEL_COUNT, max, allowDuplicatesInput.checked);
    appState = "stopping";
    stopButton.disabled = true;
    stageStatus.textContent = "왼쪽 이빨부터 하나씩 정지 중…";

    currentResult.forEach((target, i) => {
      const delay = i * 300 + (i === REEL_COUNT - 1 ? 650 : 0);
      const duration = 900 + i * 45 + (i === REEL_COUNT - 1 ? 300 : 0);
      window.setTimeout(() => reels[i].beginStop(target, performance.now(), duration), delay);
    });
  }

  function onReelStopped(index) {
    playCue(430 + index * 54, 0.055, "triangle", 0.045);
    const cell = resultNumbers.children[index];
    if (cell) {
      cell.textContent = formatNumber(currentResult[index]);
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
      values.textContent = record.numbers.map((n) => formatNumberFor(record.max, n)).join("  ·  ");

      const time = document.createElement("span");
      time.className = "history-time";
      time.textContent = formatTimestamp(record.timestamp);

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost-button history-copy";
      copy.textContent = "복사";
      copy.addEventListener("click", () => copyText(formatRecordForCopy(record), "해당 기록을 복사했습니다."));

      main.append(values, time);
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
    return formatNumberFor(getMaxNumber(false) || DEFAULT_MAX, value);
  }

  function formatNumberFor(max, value) {
    if (!Number.isFinite(value)) return "—";
    const width = String(Math.max(1, max)).length;
    return String(value).padStart(width, "0");
  }

  function formatTimestamp(iso) {
    const date = new Date(iso);
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(date);
  }

  function formatRecordForCopy(record) {
    return record.numbers.map((n) => formatNumberFor(record.max, n)).join(", ");
  }

  function formatAllForCopy() {
    return history.map((record, index) => {
      const order = history.length - index;
      return `#${order} | ${formatTimestamp(record.timestamp)} | ${formatRecordForCopy(record)}`;
    }).join("\n");
  }

  async function copyText(text, successMessage) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      showToast(successMessage);
    }
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("lucky-mouth-roulette.history.v1");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((record) => Array.isArray(record.numbers) && record.numbers.length === REEL_COUNT).slice(0, 200);
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      showToast("기록을 브라우저에 저장하지 못했습니다.");
    }
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

  function cryptoRandomId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${secureRandomInt(100000, 999999)}`;
  }

  function unlockAudio() {
    if (!soundEnabled) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    if (audioContext.state === "suspended") audioContext.resume();
  }

  function playCue(frequency, duration, type = "sine", volume = 0.03) {
    if (!soundEnabled) return;
    unlockAudio();
    if (!audioContext) return;

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  function playFinalCue() {
    [523.25, 659.25, 783.99].forEach((frequency, i) => {
      window.setTimeout(() => playCue(frequency, 0.16, "triangle", 0.04), i * 85);
    });
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1700);
  }

  function modulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function easeOutQuint(t) {
    return 1 - Math.pow(1 - t, 5);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  spinButton.addEventListener("click", startSpin);
  stopButton.addEventListener("click", stopSpin);

  copyCurrentButton.addEventListener("click", () => {
    copyText(currentResult.map(formatNumber).join(", "), "이번 추첨 번호를 복사했습니다.");
  });

  copyAllButton.addEventListener("click", () => {
    copyText(formatAllForCopy(), "전체 기록을 복사했습니다.");
  });

  clearHistoryButton.addEventListener("click", () => {
    if (!history.length) return;
    if (!window.confirm("추첨 기록을 모두 삭제할까요?")) return;
    history = [];
    saveHistory();
    renderHistory();
    showToast("추첨 기록을 초기화했습니다.");
  });

  soundToggle.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    soundToggle.setAttribute("aria-pressed", String(soundEnabled));
    soundToggle.textContent = soundEnabled ? "🔊" : "🔇";
    if (soundEnabled) playCue(500, 0.05, "sine", 0.02);
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
    event.preventDefault();
    if (appState === "spinning") stopSpin();
    else if (appState !== "stopping") startSpin();
  });

  image.addEventListener("error", () => {
    stageStatus.textContent = "캐릭터 이미지를 불러오지 못했습니다.";
    showToast("assets/lucky.webp 로딩에 실패했습니다.");
  });

  renderHistory();
  renderTeeth();
  requestAnimationFrame(animate);
})();
