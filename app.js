(() => {
  "use strict";

  const MAX_REELS = 7;
  const HISTORY_STORAGE_KEY = "lucky-mouth-roulette.history.v1";
  const SETTINGS_STORAGE_KEY = "mya-lotto.settings.v1";
  const CHECKER_STORAGE_KEY = "mya-lotto.checker.v1";
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

  const tabButtons = [...document.querySelectorAll(".tab-button")];
  const drawPanel = document.getElementById("drawPanel");
  const checkPanel = document.getElementById("checkPanel");
  const winningNumbersInput = document.getElementById("winningNumbers");
  const bonusNumberInput = document.getElementById("bonusNumber");
  const checkNumbersButton = document.getElementById("checkNumbersButton");
  const checkerSummary = document.getElementById("checkerSummary");
  const checkedCount = document.getElementById("checkedCount");
  const bestResult = document.getElementById("bestResult");
  const prizeCount = document.getElementById("prizeCount");
  const checkerResults = document.getElementById("checkerResults");
  const emptyChecker = document.getElementById("emptyChecker");

  const savedSettings = loadSettings();
  const savedChecker = loadCheckerState();
  maxNumberInput.value = String(savedSettings.max);
  drawCountInput.value = String(savedSettings.count);
  winningNumbersInput.value = savedChecker.winningNumbers || "";
  bonusNumberInput.value = savedChecker.bonusNumber || "";

  let activeTab = "draw";
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
      ctx.fillText(formatDisplayNumber(value, max), 0, 0);
    }

    ctx.globalAlpha = 1;
  }

  function renderTeeth() {
    const { dpr, width: w, height: h } = resizeCanvas();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    const count = Math.max(1, Math.min(MAX_REELS, visibleReelCount));
    const normalSlotW = (w * 0.96) / MAX_REELS;
    const groupW = normalSlotW * count;
    const groupLeft = (w - groupW) / 2;
    const faceW = normalSlotW * 0.91;
    const faceH = h * 0.82;
    const centerY = h * 0.5;
    const rowStep = faceH * 0.92;

    ctx.fillStyle = "rgba(18, 2, 4, .98)";
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < count; i++) {
      const reel = reels[i];
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
          const value = reel.visualValue(step);

          ctx.save();
          ctx.translate(x, y);
          drawReelFace(faceW, faceH, value, reel.max, alpha);
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
    if (activeTab !== "draw") return;

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

  function normalizeAndSaveSettings() {
    let max = getMaxNumber();
    const count = getDrawCount();

    if (max < count) {
      max = count;
      showToast(`번호 범위를 ${count}까지로 함께 늘렸습니다.`);
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
          numbers: record.numbers.map(Number).filter(Number.isFinite)
        }))
        .filter((record) => record.numbers.length >= 1)
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

  function parseWinningNumbers(raw) {
    const tokens = String(raw || "")
      .trim()
      .split(/[\s,;]+/)
      .filter(Boolean);

    if (tokens.length < 1 || tokens.length > MAX_REELS) {
      return { error: `당첨 번호는 1~${MAX_REELS}개를 입력하세요.` };
    }

    const numbers = tokens.map((token) => Number.parseInt(token, 10));
    if (numbers.some((n) => !Number.isFinite(n) || n < 1 || n > 999)) {
      return { error: "당첨 번호는 1~999 사이의 숫자만 사용할 수 있습니다." };
    }

    if (new Set(numbers).size !== numbers.length) {
      return { error: "당첨 번호에는 중복 숫자를 사용할 수 없습니다." };
    }

    return { numbers };
  }

  function getBonusNumber(mainNumbers) {
    const raw = bonusNumberInput.value.trim();
    if (!raw) return { bonus: null };

    const bonus = Number.parseInt(raw, 10);
    if (!Number.isFinite(bonus) || bonus < 1 || bonus > 999) {
      return { error: "보너스 번호는 1~999 사이의 숫자여야 합니다." };
    }

    if (mainNumbers.includes(bonus)) {
      return { error: "보너스 번호는 당첨 번호와 중복될 수 없습니다." };
    }

    return { bonus };
  }

  function evaluateRecord(record, winningNumbers, bonus) {
    const mainSet = new Set(winningNumbers);
    const matched = record.numbers.filter((n) => mainSet.has(n));
    const bonusHit = bonus != null && record.numbers.includes(bonus);
    const standardLotto = winningNumbers.length === 6 && record.numbers.length === 6;

    let rank = null;
    let isPrize = false;

    if (standardLotto) {
      if (matched.length === 6) rank = "1등";
      else if (matched.length === 5 && bonusHit) rank = "2등";
      else if (matched.length === 5) rank = "3등";
      else if (matched.length === 4) rank = "4등";
      else if (matched.length === 3) rank = "5등";
      else rank = "낙첨";
      isPrize = rank !== "낙첨";
    } else {
      rank = `${matched.length}개 일치`;
      isPrize = matched.length > 0;
    }

    return {
      matched,
      matchCount: matched.length,
      bonusHit,
      standardLotto,
      rank,
      isPrize
    };
  }

  function rankScore(result) {
    if (result.standardLotto) {
      const scores = { "1등": 100, "2등": 90, "3등": 80, "4등": 70, "5등": 60, "낙첨": 0 };
      return scores[result.rank] || 0;
    }
    return result.matchCount * 10 + (result.bonusHit ? 1 : 0);
  }

  function runChecker() {
    const parsed = parseWinningNumbers(winningNumbersInput.value);
    if (parsed.error) {
      showToast(parsed.error);
      return;
    }

    const bonusResult = getBonusNumber(parsed.numbers);
    if (bonusResult.error) {
      showToast(bonusResult.error);
      return;
    }

    const winningNumbers = parsed.numbers;
    const bonus = bonusResult.bonus;

    saveCheckerState({
      winningNumbers: winningNumbers.join(" "),
      bonusNumber: bonus == null ? "" : String(bonus)
    });

    checkerResults.textContent = "";

    if (!history.length) {
      checkerSummary.hidden = true;
      emptyChecker.hidden = false;
      emptyChecker.textContent = "비교할 추첨 기록이 없습니다.";
      return;
    }

    const evaluations = history.map((record) => evaluateRecord(record, winningNumbers, bonus));
    let bestIndex = 0;

    for (let i = 1; i < evaluations.length; i++) {
      if (rankScore(evaluations[i]) > rankScore(evaluations[bestIndex])) bestIndex = i;
    }

    const best = evaluations[bestIndex];
    const standardMode = winningNumbers.length === 6 && history.some((record) => record.numbers.length === 6);
    const prizes = evaluations.filter((result) => result.isPrize).length;

    checkedCount.textContent = String(history.length);
    bestResult.textContent = best.rank;
    prizeCount.textContent = standardMode ? String(prizes) : `${prizes}개`;
    checkerSummary.hidden = false;
    emptyChecker.hidden = true;

    history.forEach((record, index) => {
      const result = evaluations[index];
      const li = document.createElement("li");
      li.className = "checker-result-item";

      const head = document.createElement("div");
      head.className = "checker-result-head";

      const rank = document.createElement("span");
      rank.className = `checker-rank${result.rank === "낙첨" || result.matchCount === 0 ? " miss" : ""}`;
      rank.textContent = `#${history.length - index} · ${result.rank}`;

      const count = document.createElement("span");
      count.className = "match-count";
      count.textContent = result.bonusHit
        ? `당첨 ${result.matchCount}개 + 보너스`
        : `당첨 ${result.matchCount}개`;

      head.append(rank, count);

      const numberRow = document.createElement("div");
      numberRow.className = "checker-number-row";

      record.numbers.forEach((number) => {
        const pill = document.createElement("span");
        pill.className = "checker-number";
        pill.textContent = formatDisplayNumber(number, record.max);

        if (winningNumbers.includes(number)) pill.classList.add("match");
        if (bonus != null && number === bonus) pill.classList.add("bonus-match");

        numberRow.appendChild(pill);
      });

      li.append(head, numberRow);
      checkerResults.appendChild(li);
    });
  }

  function loadCheckerState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CHECKER_STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") return { winningNumbers: "", bonusNumber: "" };
      return {
        winningNumbers: typeof parsed.winningNumbers === "string" ? parsed.winningNumbers : "",
        bonusNumber: typeof parsed.bonusNumber === "string" ? parsed.bonusNumber : ""
      };
    } catch {
      return { winningNumbers: "", bonusNumber: "" };
    }
  }

  function saveCheckerState(state) {
    try {
      localStorage.setItem(CHECKER_STORAGE_KEY, JSON.stringify(state));
    } catch {
      showToast("당첨 번호를 브라우저에 저장하지 못했습니다.");
    }
  }

  function switchTab(tabName) {
    activeTab = tabName === "check" ? "check" : "draw";

    tabButtons.forEach((button) => {
      const active = button.dataset.tab === activeTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });

    const drawActive = activeTab === "draw";
    drawPanel.hidden = !drawActive;
    drawPanel.classList.toggle("active", drawActive);
    checkPanel.hidden = drawActive;
    checkPanel.classList.toggle("active", !drawActive);

    if (drawActive) {
      stage.setAttribute("aria-label", "회전 시작 또는 정지");
      stageStatus.textContent = appState === "spinning"
        ? `${activeReels.length}개의 이빨 릴 회전 중 · 다시 클릭하거나 Space로 정지`
        : appState === "stopping"
          ? "왼쪽 릴부터 하나씩 정지 중…"
          : currentResult.length
            ? `완료 · ${formatRecordNumbers({ max: getMaxNumber(), numbers: currentResult })}`
            : "이미지 클릭 또는 Space 키로 시작";
    } else {
      stage.setAttribute("aria-label", "번호 확인 탭");
      stageStatus.textContent = "추첨 기록과 실제 당첨 번호를 비교하는 중";
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
    if (event.code !== "Enter" || event.repeat || activeTab !== "draw") return;
    event.preventDefault();
    toggleDraw();
  });

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || activeTab !== "draw") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLElement && event.target.isContentEditable) return;

    event.preventDefault();
    event.stopPropagation();
    toggleDraw();
  }, true);

  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space" || activeTab !== "draw") return;
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
    checkerResults.textContent = "";
    checkerSummary.hidden = true;
    emptyChecker.hidden = false;
    emptyChecker.textContent = "비교할 추첨 기록이 없습니다.";
    showToast("추첨 기록을 초기화했습니다.");
  });

  maxNumberInput.addEventListener("change", normalizeAndSaveSettings);
  drawCountInput.addEventListener("change", normalizeAndSaveSettings);

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  checkNumbersButton.addEventListener("click", runChecker);

  winningNumbersInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    runChecker();
  });

  bonusNumberInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    runChecker();
  });

  saveSettings(savedSettings);
  buildResultCells(savedSettings.count);
  renderHistory();
  switchTab("draw");
  requestAnimationFrame(animate);
})();
