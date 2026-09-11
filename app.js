(() => {
  "use strict";

  const REEL_COUNT = 7;
  const STORAGE_KEY = "lucky-mouth-roulette.history.v1";
  const DEFAULT_MAX = 45;

  const canvas = document.getElementById("teethCanvas");
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
  let previousFrameTime = performance.now();
  let soundEnabled = true;
  let audioContext = null;
  let toastTimer = 0;

  class ToothReel {
    constructor(index) {
      this.index = index;
      this.phase = index * 0.37;
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
      this.phase = randomFloat(0, 80) + this.index * 0.31;
      this.speed = randomFloat(10.5, 14.5) + this.index * 0.35;
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
      const extraFaces = 11 + this.index * 2 + secureRandomInt(0, 3);
      this.stopTo = Math.ceil(this.phase) + extraFaces;
      this.stopDuration = duration;
      this.stopNotified = false;
    }

    update(dt, now) {
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.2);
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
      if (this.mode === "stopping" && this.target != null && step >= Math.round(this.stopTo)) return this.target;
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
    return dpr;
  }

  function mouthPath(w, h) {
    const p = new Path2D();
    p.moveTo(w * 0.045, h * 0.18);
    p.bezierCurveTo(w * 0.19, h * 0.05, w * 0.79, h * 0.05, w * 0.955, h * 0.18);
    p.bezierCurveTo(w * 0.99, h * 0.35, w * 0.91, h * 0.80, w * 0.76, h * 0.88);
    p.bezierCurveTo(w * 0.56, h * 0.97, w * 0.28, h * 0.94, w * 0.12, h * 0.79);
    p.bezierCurveTo(w * 0.03, h * 0.69, w * 0.005, h * 0.34, w * 0.045, h * 0.18);
    p.closePath();
    return p;
  }

  function toothPath(width, height) {
    const p = new Path2D();
    const r = Math.min(width, height) * 0.14;
    const taper = width * 0.08;
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
    const dpr = resizeCanvas();
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cavity = mouthPath(w, h);
    const cavityGradient = ctx.createLinearGradient(0, 0, 0, h);
    cavityGradient.addColorStop(0, "rgba(48, 5, 8, .98)");
    cavityGradient.addColorStop(.6, "rgba(17, 2, 5, .99)");
    cavityGradient.addColorStop(1, "rgba(70, 7, 10, .98)");
    ctx.fillStyle = cavityGradient;
    ctx.fill(cavity);

    ctx.save();
    ctx.clip(cavity);

    const left = w * 0.085;
    const right = w * 0.915;
    const areaW = right - left;
    const slotW = areaW / REEL_COUNT;
    const baseW = slotW * 0.91;
    const baseH = h * 0.70;
    const centerY = h * 0.45;

    for (let i = 0; i < REEL_COUNT; i++) {
      const reel = reels[i];
      const nearest = Math.round(reel.phase);
      const frac = reel.phase - nearest;
      const angle = frac * Math.PI;
      const scaleY = Math.max(0.055, Math.abs(Math.cos(angle)));
      const x = left + slotW * (i + 0.5);
      const arch = Math.abs(i - 3) * h * 0.012;
      const y = centerY + arch + Math.sin(angle) * h * 0.035;
      const value = reel.mode === "idle" ? null : reel.visualValue(nearest);

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, scaleY);
      const tooth = toothPath(baseW, baseH);
      const shade = 0.72 + 0.28 * scaleY;
      const g = ctx.createLinearGradient(0, -baseH / 2, 0, baseH / 2);
      g.addColorStop(0, `rgba(255, 255, 248, ${shade})`);
      g.addColorStop(.52, `rgba(255, 242, 222, ${shade})`);
      g.addColorStop(1, `rgba(224, 191, 164, ${shade})`);
      ctx.fillStyle = g;
      ctx.shadowColor = "rgba(77, 19, 8, .45)";
      ctx.shadowBlur = h * 0.055;
      ctx.fill(tooth);
      ctx.lineWidth = Math.max(0.55, w * 0.0022);
      ctx.strokeStyle = "rgba(128, 65, 39, .32)";
      ctx.stroke(tooth);

      if (scaleY > 0.20) {
        ctx.globalAlpha = Math.min(1, (scaleY - 0.18) / 0.45);
        ctx.fillStyle = "#7d2d18";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `900 ${Math.min(baseW * 0.62, baseH * 0.55)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
        ctx.shadowColor = "rgba(255,255,255,.48)";
        ctx.shadowBlur = 1;
        ctx.fillText(value == null ? "·" : formatNumber(value), 0, 0);
      }
      ctx.restore();

      if (reel.flash > 0) {
        const glow = ctx.createRadialGradient(x, centerY, 0, x, centerY, slotW * 1.1);
        glow.addColorStop(0, `rgba(255, 240, 168, ${0.72 * reel.flash})`);
        glow.addColorStop(1, "rgba(255, 173, 44, 0)");
        ctx.fillStyle = glow;
        ctx.fillRect(x - slotW * 1.1, 0, slotW * 2.2, h);
      }
    }

    const topLipShadow = ctx.createLinearGradient(0, 0, 0, h * .25);
    topLipShadow.addColorStop(0, "rgba(33, 0, 2, .58)");
    topLipShadow.addColorStop(1, "rgba(33, 0, 2, 0)");
    ctx.fillStyle = topLipShadow;
    ctx.fillRect(0, 0, w, h * .28);
    ctx.restore();

    ctx.lineWidth = Math.max(.7, w * .004);
    ctx.strokeStyle = "rgba(115, 28, 18, .76)";
    ctx.stroke(cavity);
  }

  function animate(now) {
    const dt = Math.min(0.05, (now - previousFrameTime) / 1000);
    previousFrameTime = now;
    reels.forEach((reel) => {
      if (reel.update(dt, now)) onReelStopped(reel.index);
    });
    renderTeeth();
    if (appState === "stopping" && reels.every((reel) => reel.mode === "stopped")) finalizeDraw();
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
      const delay = i * 285 + (i === REEL_COUNT - 1 ? 620 : 0);
      const duration = 900 + i * 45 + (i === REEL_COUNT - 1 ? 260 : 0);
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
    if (allowDuplicates) return Array.from({ length: count }, () => secureRandomInt(1, max));
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

  function secureRandomInt(min, max) {
    const range = max - min + 1;
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
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return min + (a[0] / 0xffffffff) * (max - min);
  }

  function cryptoRandomId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${secureRandomInt(100000, 999999)}`;
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "—";
    const max = Number.parseInt(maxNumberInput.value, 10) || DEFAULT_MAX;
    return String(value).padStart(max >= 10 ? 2 : 1, "0");
  }

  function formatTimestamp(iso) {
    return new Intl.DateTimeFormat("ko-KR", {
      year: "2-digit", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(new Date(iso));
  }

  function formatRecordForCopy(record) {
    return record.numbers.map((n) => String(n).padStart(record.max >= 10 ? 2 : 1, "0")).join(" ");
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
      values.textContent = record.numbers.map((n) => String(n).padStart(record.max >= 10 ? 2 : 1, "0")).join(" · ");
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

  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((x) => Array.isArray(x.numbers) && x.numbers.length === REEL_COUNT) : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); }
    catch { showToast("브라우저 저장소에 기록을 저장하지 못했습니다."); }
  }

  async function copyText(text, message) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      showToast(message);
    } catch {
      showToast("복사하지 못했습니다.");
    }
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1700);
  }

  function unlockAudio() {
    if (!soundEnabled) return;
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
  }

  function playCue(freq, duration, type = "sine", gainValue = 0.03) {
    if (!soundEnabled) return;
    unlockAudio();
    if (!audioContext) return;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(gainValue, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
    osc.connect(gain).connect(audioContext.destination);
    osc.start();
    osc.stop(audioContext.currentTime + duration);
  }

  function playFinalCue() {
    [523, 659, 784].forEach((f, i) => window.setTimeout(() => playCue(f, .12, "sine", .035), i * 85));
  }

  function modulo(n, m) { return ((n % m) + m) % m; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }

  spinButton.addEventListener("click", startSpin);
  stopButton.addEventListener("click", stopSpin);
  copyCurrentButton.addEventListener("click", () => copyText(currentResult.map(formatNumber).join(" "), "이번 추첨 결과를 복사했습니다."));
  copyAllButton.addEventListener("click", () => {
    const text = history.slice().reverse().map((record, i) => `${i + 1}. ${formatRecordForCopy(record)}`).join("\n");
    copyText(text, "전체 추첨 기록을 복사했습니다.");
  });
  clearHistoryButton.addEventListener("click", () => {
    if (!history.length) return;
    if (!window.confirm("저장된 추첨 기록을 모두 삭제할까요?")) return;
    history = [];
    saveHistory();
    renderHistory();
    showToast("추첨 기록을 초기화했습니다.");
  });

  soundToggle.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    soundToggle.textContent = soundEnabled ? "🔊" : "🔇";
    soundToggle.setAttribute("aria-pressed", String(soundEnabled));
    if (soundEnabled) playCue(520, .05, "sine", .025);
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
    event.preventDefault();
    if (appState === "spinning") stopSpin();
    else if (appState !== "stopping") startSpin();
  });

  window.addEventListener("resize", renderTeeth);
  renderHistory();
  renderTeeth();
  requestAnimationFrame(animate);
})();
