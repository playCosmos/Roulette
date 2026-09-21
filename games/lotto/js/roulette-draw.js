(() => {
  "use strict";

  const A = window.MyaLotto;
  const S = A.state;
  const E = A.el;

  const DEFAULT_MODE = "normal";
  const DEFAULT_AUTO_RUNS = 5;
  const MAX_AUTO_RUNS = 100;
  const MAX_MANUAL_SETS = 100;
  const MANUAL_TICKET_MAX = 28;
  const MANUAL_TICKET_COUNT = 7;
  const AUTO_SPIN_MS = 900;
  const AUTO_NEXT_MS = 650;

  const manualNumberSetting = document.getElementById("manualNumberSetting");
  const manualNumbersInput = document.getElementById("manualNumbers");

  if (!Array.isArray(S.lastAutoResult)) S.lastAutoResult = [];

  function getMaxNumber() {
    const parsed = Number.parseInt(E.maxNumberInput.value, 10);
    return Number.isFinite(parsed) ? Math.min(999, Math.max(1, parsed)) : A.DEFAULT_MAX;
  }

  function getDrawCount() {
    const parsed = Number.parseInt(E.drawCountInput.value, 10);
    return Number.isFinite(parsed) ? Math.min(A.MAX_REELS, Math.max(1, parsed)) : A.DEFAULT_COUNT;
  }

  function getAutoDrawCount() {
    const parsed = Number.parseInt(E.autoDrawCountInput.value, 10);
    return Number.isFinite(parsed)
      ? Math.min(MAX_AUTO_RUNS, Math.max(1, parsed))
      : DEFAULT_AUTO_RUNS;
  }

  function getDrawMode() {
    const selected = E.drawModeInputs.find((input) => input.checked)?.value;
    return ["normal", "continuous", "manual"].includes(selected) ? selected : DEFAULT_MODE;
  }

  function setDrawModeInput(mode) {
    const normalized = ["normal", "continuous", "manual"].includes(mode) ? mode : DEFAULT_MODE;
    E.drawModeInputs.forEach((input) => {
      input.checked = input.value === normalized;
    });
  }

  function parseManualNumberSets(showError = true) {
    const lines = String(manualNumbersInput?.value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      if (showError) A.showToast("사용자 지정 번호를 한 줄 이상 입력하세요.");
      return null;
    }

    if (lines.length > MAX_MANUAL_SETS) {
      if (showError) A.showToast(`수동 번호는 한 번에 최대 ${MAX_MANUAL_SETS}조합까지 출력할 수 있습니다.`);
      return null;
    }

    const sets = [];
    for (let index = 0; index < lines.length; index++) {
      const tokens = lines[index].match(/\d+/g) || [];
      if (tokens.length !== MANUAL_TICKET_COUNT) {
        if (showError) A.showToast(`${index + 1}번째 줄은 번호를 정확히 ${MANUAL_TICKET_COUNT}개 입력하세요.`);
        return null;
      }

      const numbers = tokens.map((token) => Number.parseInt(token, 10));
      if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > MANUAL_TICKET_MAX)) {
        if (showError) A.showToast(`${index + 1}번째 줄에는 1~${MANUAL_TICKET_MAX} 범위의 숫자만 사용할 수 있습니다.`);
        return null;
      }

      if (new Set(numbers).size !== numbers.length) {
        if (showError) A.showToast(`${index + 1}번째 줄에 중복 번호가 있습니다.`);
        return null;
      }

      sets.push(numbers);
    }

    return sets;
  }

  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(A.SETTINGS_STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") {
        return {
          max: A.DEFAULT_MAX,
          count: A.DEFAULT_COUNT,
          mode: DEFAULT_MODE,
          autoRuns: DEFAULT_AUTO_RUNS,
          manualNumbersText: ""
        };
      }

      let max = Number.parseInt(parsed.max, 10);
      let count = Number.parseInt(parsed.count, 10);
      let autoRuns = Number.parseInt(parsed.autoRuns, 10);
      const mode = ["normal", "continuous", "manual"].includes(parsed.mode) ? parsed.mode : DEFAULT_MODE;
      const manualNumbersText = typeof parsed.manualNumbersText === "string" ? parsed.manualNumbersText : "";

      max = Number.isFinite(max) ? Math.min(999, Math.max(1, max)) : A.DEFAULT_MAX;
      count = Number.isFinite(count) ? Math.min(A.MAX_REELS, Math.max(1, count)) : A.DEFAULT_COUNT;
      autoRuns = Number.isFinite(autoRuns) ? Math.min(MAX_AUTO_RUNS, Math.max(1, autoRuns)) : DEFAULT_AUTO_RUNS;
      if (max < count) max = count;
      return { max, count, mode, autoRuns, manualNumbersText };
    } catch {
      return {
        max: A.DEFAULT_MAX,
        count: A.DEFAULT_COUNT,
        mode: DEFAULT_MODE,
        autoRuns: DEFAULT_AUTO_RUNS,
        manualNumbersText: ""
      };
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(A.SETTINGS_STORAGE_KEY, JSON.stringify({
        max: settings.max,
        count: settings.count,
        mode: settings.mode || getDrawMode(),
        autoRuns: settings.autoRuns || getAutoDrawCount(),
        manualNumbersText: manualNumbersInput?.value || settings.manualNumbersText || ""
      }));
    } catch {
      A.showToast("설정값을 브라우저에 저장하지 못했습니다.");
    }
  }

  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(A.HISTORY_STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((record) => record && Array.isArray(record.numbers) && record.numbers.length >= 1 && record.numbers.length <= A.MAX_REELS)
        .map((record) => ({
          max: Number.isFinite(record.max) ? record.max : A.DEFAULT_MAX,
          numbers: record.numbers.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
        }))
        .filter((record) => record.numbers.length >= 1)
        .slice(0, 200);
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(A.HISTORY_STORAGE_KEY, JSON.stringify(S.history));
    } catch {
      A.showToast("브라우저 저장소에 기록을 저장하지 못했습니다.");
    }
  }

  function buildResultCells(count, container = E.resultNumbers) {
    if (!container) return;
    container.textContent = "";
    for (let i = 0; i < count; i++) {
      const cell = document.createElement("span");
      cell.textContent = "—";
      container.appendChild(cell);
    }
  }

  function setResultPlaceholders(container = E.resultNumbers) {
    if (!container) return;
    [...container.children].forEach((cell) => {
      cell.textContent = "—";
      cell.classList.remove("pop");
    });
  }

  function renderHistory() {
    E.historyList.textContent = "";
    E.emptyHistory.hidden = S.history.length > 0;
    E.copyAllButton.disabled = S.history.length === 0;
    E.clearHistoryButton.disabled = S.history.length === 0;

    S.history.forEach((record, index) => {
      const li = document.createElement("li");
      li.className = "history-item";

      const order = document.createElement("span");
      order.className = "history-index";
      order.textContent = `#${S.history.length - index}`;

      const sortedRecord = {
        ...record,
        numbers: record.numbers.slice().sort((a, b) => a - b)
      };

      const values = document.createElement("span");
      values.className = "history-values";
      values.textContent = A.formatRecordNumbers(sortedRecord);

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost-button history-copy";
      copy.textContent = "복사";
      copy.addEventListener("click", (event) => {
        event.stopPropagation();
        A.copyText(A.formatRecordNumbers(sortedRecord), "해당 번호를 복사했습니다.");
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost-button danger history-delete";
      remove.textContent = "삭제";
      remove.setAttribute("aria-label", `${S.history.length - index}번 발급 기록 삭제`);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        S.history.splice(index, 1);
        saveHistory();
        renderHistory();
        A.live?.refreshComparison?.();
        A.showToast("발급 기록 1건을 삭제했습니다.");
      });

      li.append(order, values, copy, remove);
      E.historyList.append(li);
    });
  }

  function drawUniqueNumbers(count, max) {
    const pool = Array.from({ length: max }, (_, i) => i + 1);
    for (let i = 0; i < count; i++) {
      const j = A.secureRandomInt(i, pool.length - 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
  }

  function getValidatedSettings(showError) {
    const max = getMaxNumber();
    const count = getDrawCount();
    const mode = getDrawMode();
    const autoRuns = getAutoDrawCount();

    E.maxNumberInput.value = String(max);
    E.drawCountInput.value = String(count);
    E.autoDrawCountInput.value = String(autoRuns);

    if (max < count) {
      if (showError) A.showToast(`중복 없이 ${count}개를 발급하려면 번호 범위가 최소 ${count}까지 필요합니다.`);
      return null;
    }

    return { max, count, mode, autoRuns };
  }

  function setSettingsDisabled(disabled) {
    const manualMode = getDrawMode() === "manual";
    E.maxNumberInput.disabled = disabled || manualMode;
    E.drawCountInput.disabled = disabled || manualMode;
    E.autoDrawCountInput.disabled = disabled;
    E.drawModeInputs.forEach((input) => { input.disabled = disabled; });
    if (manualNumbersInput) manualNumbersInput.disabled = disabled;
    A.ticket?.setDisabled?.(disabled);
  }

  function updateModeUi(mode = getDrawMode()) {
    const descriptions = {
      normal: "1회 시작 후 다시 눌러 자동 발급 번호를 왼쪽부터 순차 확정합니다.",
      continuous: "한 번 시작하면 지정한 횟수만큼 자동 번호 발급을 반복합니다. 실행 중 다시 누르면 현재 회차 후 중지합니다.",
      manual: "1~28 번호 7개를 한 줄에 한 조합씩 입력합니다. 릴은 돌리지 않고 입력한 모든 조합의 티켓 이미지만 바로 출력합니다."
    };

    E.autoRepeatSetting.hidden = mode !== "continuous";
    if (manualNumberSetting) manualNumberSetting.hidden = mode !== "manual";
    E.modeDescription.textContent = descriptions[mode] || descriptions.normal;
    setSettingsDisabled(false);
  }

  function getIdleStatus(mode, count, autoRuns) {
    if (mode === "continuous") return `자동 번호 ${count}개 × ${autoRuns}회 · 이미지 클릭 또는 Space로 시작`;
    if (mode === "manual") return "사용자 지정 티켓 이미지 출력 · 이미지 클릭 또는 Space로 실행";
    return `자동 번호 ${count}개 발급 · 이미지 클릭 또는 Space로 시작`;
  }

  function normalizeAndSaveSettings() {
    if (!["idle", "result"].includes(S.appState) || S.autoDrawRunning) return;

    let max = getMaxNumber();
    const count = getDrawCount();
    const mode = getDrawMode();
    const autoRuns = getAutoDrawCount();

    if (max < count) {
      max = count;
      A.showToast(`번호 범위를 ${count}까지로 함께 늘렸습니다.`);
    }

    E.maxNumberInput.value = String(max);
    E.drawCountInput.value = String(count);
    E.autoDrawCountInput.value = String(autoRuns);
    S.visibleReelCount = count;
    S.activeReels = Array.from({ length: count }, (_, i) => i);
    S.currentDrawSettings = { max, count, mode, autoRuns };
    saveSettings(S.currentDrawSettings);
    updateModeUi(mode);
    A.ticket?.refreshHint?.();

    S.appState = "idle";
    S.currentResult = [];
    S.manualNextIndex = 0;
    S.manualStopPending = false;
    A.reels.forEach((reel) => reel.reset());
    if (mode !== "manual") {
      buildResultCells(count);
      setResultPlaceholders();
      E.copyCurrentButton.disabled = true;
    }
    E.stageStatus.textContent = getIdleStatus(mode, count, autoRuns);
  }

  function startSpin(mode = getDrawMode(), settingsOverride = null) {
    if (!["idle", "result"].includes(S.appState)) return false;
    const settings = settingsOverride || getValidatedSettings(true);
    if (!settings) return false;

    S.currentDrawSettings = { ...settings, mode };
    S.visibleReelCount = settings.count;
    S.activeReels = Array.from({ length: settings.count }, (_, i) => i);
    S.manualNextIndex = 0;
    S.manualStopPending = false;
    S.appState = "spinning";
    S.currentResult = [];

    E.stage.classList.remove("final-win");
    buildResultCells(settings.count);
    setResultPlaceholders();
    A.reels.forEach((reel) => reel.reset());
    S.activeReels.forEach((index) => A.reels[index].start(settings.max));
    setSettingsDisabled(true);
    E.copyCurrentButton.disabled = true;

    E.stageStatus.textContent = mode === "continuous"
      ? `연속 자동 ${S.autoDrawCompleted + 1}/${S.autoDrawTarget}회차 · 회전 중`
      : `${settings.count}개 자동 번호 발급 중 · 다시 눌러 확정`;
    return true;
  }

  function scheduleSequentialStops(faster = false) {
    S.activeReels.forEach((reelIndex, resultIndex) => {
      const isLast = resultIndex === S.activeReels.length - 1;
      const delay = faster
        ? resultIndex * 210 + (isLast ? 360 : 0)
        : resultIndex * 280 + (isLast ? 620 : 0);
      const duration = faster
        ? 720 + resultIndex * 30 + (isLast ? 180 : 0)
        : 900 + resultIndex * 45 + (isLast ? 260 : 0);
      const target = S.currentResult[resultIndex];

      window.setTimeout(() => {
        A.reels[reelIndex].beginStop(target, performance.now(), duration);
      }, delay);
    });
  }

  function stopAllSequential() {
    if (S.appState !== "spinning") return;
    S.currentResult = drawUniqueNumbers(S.currentDrawSettings.count, S.currentDrawSettings.max);
    S.appState = "stopping";
    E.stageStatus.textContent = "자동 발급 번호를 왼쪽부터 확정 중…";
    scheduleSequentialStops(false);
  }

  function startAutoRound() {
    if (!S.autoDrawRunning) return;
    S.appState = "result";
    if (!startSpin("continuous", S.currentDrawSettings)) return;

    window.clearTimeout(S.autoTimer);
    S.autoTimer = window.setTimeout(() => {
      if (!S.autoDrawRunning || S.appState !== "spinning") return;
      S.currentResult = drawUniqueNumbers(S.currentDrawSettings.count, S.currentDrawSettings.max);
      S.appState = "stopping";
      E.stageStatus.textContent = `연속 자동 ${S.autoDrawCompleted + 1}/${S.autoDrawTarget}회차 · 번호 확정 중`;
      scheduleSequentialStops(true);
    }, AUTO_SPIN_MS);
  }

  function startAutoSequence() {
    const settings = getValidatedSettings(true);
    if (!settings) return;

    S.autoDrawTarget = getAutoDrawCount();
    S.autoDrawCompleted = 0;
    S.autoDrawRunning = true;
    S.autoCancelRequested = false;
    S.currentDrawSettings = { ...settings, mode: "continuous", autoRuns: S.autoDrawTarget };
    saveSettings(S.currentDrawSettings);
    setSettingsDisabled(true);
    startAutoRound();
  }

  async function issueManualBatch() {
    if (!["idle", "result"].includes(S.appState) || S.autoDrawRunning) return;

    if (!A.ticket?.isEnabled?.()) {
      A.showToast("수동 모드는 '이미지 출력'을 체크해야 실행됩니다.");
      return;
    }

    if (typeof A.ticket.enqueueMany !== "function") {
      A.showToast("티켓 이미지 출력 기능을 불러오지 못했습니다.");
      return;
    }

    const manualSets = parseManualNumberSets(true);
    if (!manualSets) return;

    const settings = {
      max: getMaxNumber(),
      count: getDrawCount(),
      mode: "manual",
      autoRuns: getAutoDrawCount()
    };
    saveSettings(settings);

    const records = manualSets.map((numbers) => ({
      max: MANUAL_TICKET_MAX,
      numbers: numbers.slice()
    }));

    S.currentDrawSettings = { ...settings };
    S.appState = "manual";
    S.currentResult = [];
    A.reels.forEach((reel) => reel.reset());
    setSettingsDisabled(true);
    E.stageStatus.textContent = `사용자 지정 티켓 ${records.length}장 생성 중…`;

    try {
      const results = await A.ticket.enqueueMany(records);
      const successCount = results.filter(Boolean).length;
      E.stageStatus.textContent = `수동 티켓 출력 완료 · ${successCount}/${records.length}장`;
      A.showToast(`사용자 지정 티켓 ${successCount}장을 출력했습니다.`);
    } catch (error) {
      console.error(error);
      E.stageStatus.textContent = "수동 티켓 출력 중 오류가 발생했습니다.";
      A.showToast("수동 티켓 출력 중 오류가 발생했습니다.");
    } finally {
      S.appState = "result";
      setSettingsDisabled(false);
    }
  }

  function toggleDraw() {
    if (S.activeTab !== "draw") return;
    const mode = getDrawMode();

    if (mode === "manual") {
      if (["idle", "result"].includes(S.appState)) void issueManualBatch();
      return;
    }

    if (mode === "continuous") {
      if (S.autoDrawRunning) {
        S.autoCancelRequested = true;
        if (S.appState === "result") {
          window.clearTimeout(S.autoTimer);
          S.autoDrawRunning = false;
          S.autoCancelRequested = false;
          setSettingsDisabled(false);
          E.copyCurrentButton.disabled = !S.lastAutoResult.length;
          E.stageStatus.textContent = `연속 자동 중지 · ${S.autoDrawCompleted}/${S.autoDrawTarget}회 완료`;
        } else {
          E.stageStatus.textContent = `중지 요청 · 현재 회차 후 종료 (${S.autoDrawCompleted}/${S.autoDrawTarget}회 완료)`;
        }
        return;
      }

      if (["idle", "result"].includes(S.appState)) startAutoSequence();
      return;
    }

    if (["idle", "result"].includes(S.appState)) {
      startSpin("normal");
      return;
    }

    if (S.appState === "spinning" && S.currentDrawSettings?.mode === "normal") stopAllSequential();
  }

  A.handleReelStopped = (reelIndex) => {
    const resultIndex = S.activeReels.indexOf(reelIndex);
    if (resultIndex < 0) return;

    if (S.currentDrawSettings?.mode === "live") {
      A.live?.onReelStopped?.(resultIndex, S.currentResult[resultIndex]);
      if (resultIndex !== S.manualNextIndex) return;
      S.manualStopPending = false;
      S.manualNextIndex += 1;

      if (S.manualNextIndex >= S.activeReels.length) {
        A.finalizeDraw();
      } else {
        E.stageStatus.textContent = `${S.manualNextIndex}/${S.activeReels.length}개 추첨 · 다시 눌러 ${S.manualNextIndex + 1}번째 번호 추첨`;
      }
      return;
    }

    const cell = E.resultNumbers.children[resultIndex];
    if (cell && S.currentResult[resultIndex] != null) {
      cell.textContent = A.formatDisplayNumber(S.currentResult[resultIndex], S.currentDrawSettings.max);
      cell.classList.remove("pop");
      void cell.offsetWidth;
      cell.classList.add("pop");
    }

    if (resultIndex < S.activeReels.length - 1) {
      E.stageStatus.textContent = S.currentDrawSettings.mode === "continuous"
        ? `연속 자동 ${S.autoDrawCompleted + 1}/${S.autoDrawTarget}회차 · ${resultIndex + 1}/${S.activeReels.length} 확정`
        : `${resultIndex + 1}/${S.activeReels.length} 확정 · 다음 릴 감속 중…`;
    } else {
      E.stageStatus.textContent = "마지막 번호 확정!";
    }
  };

  A.finalizeDraw = () => {
    if (!["stopping", "manual"].includes(S.appState)) return;
    const mode = S.currentDrawSettings?.mode;
    S.appState = "result";

    if (mode === "live") {
      E.stage.classList.add("final-win");
      window.setTimeout(() => E.stage.classList.remove("final-win"), 1000);
      A.live?.onComplete?.(S.currentResult.slice(), S.currentDrawSettings.max);
      return;
    }

    const record = {
      max: S.currentDrawSettings.max,
      numbers: S.currentResult.slice().sort((a, b) => a - b)
    };
    S.lastAutoResult = record.numbers.slice();
    S.history.unshift(record);
    S.history = S.history.slice(0, 200);
    saveHistory();
    renderHistory();

    E.stage.classList.add("final-win");
    window.setTimeout(() => E.stage.classList.remove("final-win"), 1000);

    if (mode === "continuous" && S.autoDrawRunning) {
      S.autoDrawCompleted += 1;
      if (S.autoCancelRequested || S.autoDrawCompleted >= S.autoDrawTarget) {
        S.autoDrawRunning = false;
        S.autoCancelRequested = false;
        setSettingsDisabled(false);
        E.copyCurrentButton.disabled = false;
        E.stageStatus.textContent = `연속 자동 완료 · ${S.autoDrawCompleted}회 발급`;
        return;
      }

      E.stageStatus.textContent = `연속 자동 ${S.autoDrawCompleted}/${S.autoDrawTarget}회 완료 · 다음 발급 준비`;
      window.clearTimeout(S.autoTimer);
      S.autoTimer = window.setTimeout(startAutoRound, AUTO_NEXT_MS);
      return;
    }

    setSettingsDisabled(false);
    E.copyCurrentButton.disabled = false;
    E.stageStatus.textContent = `발급 완료 · ${A.formatRecordNumbers(record)}`;
  };

  A.initDraw = () => {
    const saved = loadSettings();
    E.maxNumberInput.value = String(saved.max);
    E.drawCountInput.value = String(saved.count);
    E.autoDrawCountInput.value = String(saved.autoRuns);
    if (manualNumbersInput) manualNumbersInput.value = saved.manualNumbersText || "";
    setDrawModeInput(saved.mode);
    S.currentDrawSettings = { ...saved };
    S.visibleReelCount = saved.count;
    S.activeReels = Array.from({ length: saved.count }, (_, i) => i);
    S.history = loadHistory();
    saveSettings(saved);
    updateModeUi(saved.mode);
    buildResultCells(saved.count);
    renderHistory();
    E.stageStatus.textContent = getIdleStatus(saved.mode, saved.count, saved.autoRuns);

    manualNumbersInput?.addEventListener("change", normalizeAndSaveSettings);
  };

  A.draw = {
    getMaxNumber,
    getDrawCount,
    getAutoDrawCount,
    getDrawMode,
    getIdleStatus,
    toggleDraw,
    normalizeAndSaveSettings,
    renderHistory,
    saveHistory,
    buildResultCells,
    setResultPlaceholders
  };
})();