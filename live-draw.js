(() => {
  "use strict";

  const A = window.MyaLotto;
  const S = A.state;
  const STORAGE_KEY = "mya-lotto.live-draw.v1";

  const el = {
    max: document.getElementById("liveMaxNumber"),
    count: document.getElementById("liveDrawCount"),
    resultNumbers: document.getElementById("liveResultNumbers"),
    progress: document.getElementById("liveProgress"),
    summary: document.getElementById("checkerSummary"),
    checkedCount: document.getElementById("checkedCount"),
    bestResult: document.getElementById("bestResult"),
    prizeCount: document.getElementById("prizeCount"),
    prizeCountLabel: document.getElementById("prizeCountLabel"),
    results: document.getElementById("checkerResults"),
    empty: document.getElementById("emptyChecker"),
    recheckStored: document.getElementById("recheckStoredButton"),
    batch: document.getElementById("batchRecords"),
    loadHistory: document.getElementById("loadSavedHistoryButton"),
    checkBatch: document.getElementById("checkPastedRecordsButton"),
    clearBatch: document.getElementById("clearBatchRecordsButton")
  };

  const L = {
    max: A.DEFAULT_MAX,
    count: A.DEFAULT_COUNT,
    completed: false,
    numbers: []
  };

  function getMax() {
    const parsed = Number.parseInt(el.max.value, 10);
    return Number.isFinite(parsed) ? Math.min(999, Math.max(1, parsed)) : A.DEFAULT_MAX;
  }

  function getCount() {
    const parsed = Number.parseInt(el.count.value, 10);
    return Number.isFinite(parsed) ? Math.min(A.MAX_REELS, Math.max(1, parsed)) : A.DEFAULT_COUNT;
  }

  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") return;

      let max = Number.parseInt(parsed.max, 10);
      let count = Number.parseInt(parsed.count, 10);
      max = Number.isFinite(max) ? Math.min(999, Math.max(1, max)) : A.DEFAULT_MAX;
      count = Number.isFinite(count) ? Math.min(A.MAX_REELS, Math.max(1, count)) : A.DEFAULT_COUNT;
      if (max < count) max = count;
      L.max = max;
      L.count = count;
    } catch {
      // 기본값 유지
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ max: L.max, count: L.count }));
    } catch {
      // 설정 저장 실패는 추첨 자체를 막지 않는다.
    }
  }

  function normalizeSettings() {
    if (["spinning", "stopping", "manual"].includes(S.appState)) return;

    let max = getMax();
    const count = getCount();
    if (max < count) {
      max = count;
      A.showToast(`중복 없이 ${count}개를 추첨하려면 번호 범위가 최소 ${count}까지 필요합니다.`);
    }

    L.max = max;
    L.count = count;
    L.completed = false;
    L.numbers = [];
    el.max.value = String(max);
    el.count.value = String(count);
    saveSettings();
    buildResultCells();
    clearComparison();

    if (S.activeTab === "check") restoreIdleStage();
  }

  function setInputsDisabled(disabled) {
    el.max.disabled = disabled;
    el.count.disabled = disabled;
  }

  function buildResultCells() {
    A.draw.buildResultCells(L.count, el.resultNumbers);
  }

  function clearComparison() {
    el.summary.hidden = true;
    el.results.textContent = "";
    el.empty.hidden = false;
    el.empty.textContent = "실시간 추첨을 완료하면 자동 발급 기록과 비교합니다.";
    el.recheckStored.disabled = true;
  }

  function restoreIdleStage() {
    S.appState = "idle";
    S.currentResult = [];
    S.currentDrawSettings = { max: L.max, count: L.count, mode: "live", autoRuns: 1 };
    S.visibleReelCount = L.count;
    S.activeReels = Array.from({ length: L.count }, (_, index) => index);
    S.manualNextIndex = 0;
    S.manualStopPending = false;
    A.reels.forEach((reel) => reel.reset());
    el.progress.textContent = "대기 중";
    A.el.stageStatus.textContent = `${L.count}개 실시간 추첨 · 이미지 클릭 또는 Space로 전체 회전 시작`;
  }

  function restoreCompletedStage() {
    S.appState = "result";
    S.currentResult = L.numbers.slice();
    S.currentDrawSettings = { max: L.max, count: L.count, mode: "live", autoRuns: 1 };
    S.visibleReelCount = L.count;
    S.activeReels = Array.from({ length: L.count }, (_, index) => index);
    S.manualNextIndex = L.count;
    S.manualStopPending = false;

    A.reels.forEach((reel, index) => {
      reel.reset();
      if (index >= L.count) return;
      reel.max = L.max;
      reel.mode = "stopped";
      reel.target = L.numbers[index];
      reel.position = 0;
      reel.stopTo = 0;
    });

    el.progress.textContent = "추첨 완료";
    A.el.stageStatus.textContent = `실시간 추첨 완료 · ${A.formatRecordNumbers({ max: L.max, numbers: L.numbers })}`;
  }

  function startLiveDraw() {
    if (!["idle", "result"].includes(S.appState)) return false;

    L.max = getMax();
    L.count = getCount();
    if (L.max < L.count) {
      A.showToast(`중복 없이 ${L.count}개를 추첨하려면 번호 범위가 최소 ${L.count}까지 필요합니다.`);
      return false;
    }

    el.max.value = String(L.max);
    el.count.value = String(L.count);
    saveSettings();

    L.completed = false;
    L.numbers = [];
    S.currentDrawSettings = { max: L.max, count: L.count, mode: "live", autoRuns: 1 };
    S.visibleReelCount = L.count;
    S.activeReels = Array.from({ length: L.count }, (_, index) => index);
    S.manualNextIndex = 0;
    S.manualStopPending = false;
    S.currentResult = Array(L.count).fill(null);
    S.appState = "spinning";

    A.el.stage.classList.remove("final-win");
    A.reels.forEach((reel) => reel.reset());
    S.activeReels.forEach((index) => A.reels[index].start(L.max));
    buildResultCells();
    clearComparison();
    setInputsDisabled(true);
    el.progress.textContent = `0/${L.count} 추첨`;
    A.el.stageStatus.textContent = `${L.count}개 릴 회전 중 · 다시 눌러 1번째 번호 실시간 추첨`;
    return true;
  }

  function drawNextNumber() {
    const used = new Set(S.currentResult.filter(Number.isFinite));
    const available = [];
    for (let number = 1; number <= L.max; number++) {
      if (!used.has(number)) available.push(number);
    }
    if (!available.length) throw new Error("No available draw numbers");
    return available[A.secureRandomInt(0, available.length - 1)];
  }

  function stopNextLiveReel() {
    if (S.currentDrawSettings?.mode !== "live" || S.manualStopPending) return false;
    if (!["spinning", "manual"].includes(S.appState)) return false;
    if (S.manualNextIndex >= S.activeReels.length) return false;

    const resultIndex = S.manualNextIndex;
    const reelIndex = S.activeReels[resultIndex];

    // 핵심: 목표 번호는 회전 시작 시 미리 정하지 않고,
    // 사용자가 이 릴을 멈추는 바로 이 순간에 생성한다.
    const target = drawNextNumber();
    S.currentResult[resultIndex] = target;
    S.appState = "manual";
    S.manualStopPending = true;
    A.el.stageStatus.textContent = `${resultIndex + 1}번째 번호 실시간 추첨 중…`;

    return A.reels[reelIndex].beginStop(target, performance.now(), 760 + resultIndex * 28);
  }

  function toggle() {
    if (S.activeTab !== "check") return;

    if (["idle", "result"].includes(S.appState)) {
      startLiveDraw();
      return;
    }

    if (["spinning", "manual"].includes(S.appState) && S.currentDrawSettings?.mode === "live") {
      stopNextLiveReel();
    }
  }

  function onReelStopped(index, value) {
    L.numbers[index] = value;
    const cell = el.resultNumbers.children[index];
    if (cell) {
      cell.textContent = A.formatDisplayNumber(value, L.max);
      cell.classList.remove("pop");
      void cell.offsetWidth;
      cell.classList.add("pop");
    }
    el.progress.textContent = `${index + 1}/${L.count} 추첨`;
  }

  function parseNumberList(raw, label = "번호") {
    const tokens = String(raw || "").trim().split(/[\s,;]+/).filter(Boolean);
    if (tokens.length < 1 || tokens.length > A.MAX_REELS) {
      return { error: `${label}는 1~${A.MAX_REELS}개를 입력하세요.` };
    }

    const numbers = tokens.map((token) => Number.parseInt(token, 10));
    if (numbers.some((number) => !Number.isFinite(number) || number < 1 || number > 999)) {
      return { error: `${label}에는 1~999 사이의 숫자만 사용할 수 있습니다.` };
    }
    if (new Set(numbers).size !== numbers.length) {
      return { error: `${label}에는 중복 숫자를 사용할 수 없습니다.` };
    }
    return { numbers };
  }

  function evaluateRecord(record) {
    const winningSet = new Set(L.numbers);
    const matched = record.numbers.filter((number) => winningSet.has(number));
    return {
      matchCount: matched.length,
      rank: `${matched.length}개 일치`,
      isHit: matched.length > 0
    };
  }

  function renderComparison(records, reverseNumbering) {
    el.results.textContent = "";

    if (!records.length) {
      el.summary.hidden = true;
      el.empty.hidden = false;
      el.empty.textContent = "비교할 자동 발급 기록이 없습니다.";
      return;
    }

    const evaluations = records.map(evaluateRecord);
    let bestIndex = 0;
    for (let i = 1; i < evaluations.length; i++) {
      if (evaluations[i].matchCount > evaluations[bestIndex].matchCount) bestIndex = i;
    }

    const matchedRecords = evaluations.filter((result) => result.isHit).length;
    el.checkedCount.textContent = String(records.length);
    el.bestResult.textContent = evaluations[bestIndex].rank;
    el.prizeCountLabel.textContent = "일치 기록";
    el.prizeCount.textContent = `${matchedRecords}개`;
    el.summary.hidden = false;
    el.empty.hidden = true;

    records.forEach((record, index) => {
      const result = evaluations[index];
      const li = document.createElement("li");
      li.className = "checker-result-item";

      const head = document.createElement("div");
      head.className = "checker-result-head";

      const rank = document.createElement("span");
      rank.className = `checker-rank${result.matchCount === 0 ? " miss" : ""}`;
      const displayIndex = reverseNumbering ? records.length - index : index + 1;
      rank.textContent = `#${displayIndex} · ${result.rank}`;

      const count = document.createElement("span");
      count.className = "match-count";
      count.textContent = `일치 ${result.matchCount}개`;
      head.append(rank, count);

      const numberRow = document.createElement("div");
      numberRow.className = "checker-number-row";
      record.numbers.forEach((number) => {
        const pill = document.createElement("span");
        pill.className = "checker-number";
        pill.textContent = A.formatDisplayNumber(number, record.max);
        if (L.numbers.includes(number)) pill.classList.add("match");
        numberRow.appendChild(pill);
      });

      li.append(head, numberRow);
      el.results.appendChild(li);
    });
  }

  function compareStored() {
    if (!L.completed) return A.showToast("먼저 실시간 추첨을 완료하세요.");
    renderComparison(S.history, true);
  }

  function parseBatch(raw) {
    const lines = String(raw || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return { error: "확인할 번호를 붙여넣어 주세요." };

    const records = [];
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseNumberList(lines[i], `${i + 1}번째 줄`);
      if (parsed.error) return { error: parsed.error };
      records.push({ max: Math.max(A.DEFAULT_MAX, ...parsed.numbers), numbers: parsed.numbers });
    }
    return { records };
  }

  function checkBatch() {
    if (!L.completed) return A.showToast("먼저 실시간 추첨을 완료하세요.");
    const parsed = parseBatch(el.batch.value);
    if (parsed.error) return A.showToast(parsed.error);
    renderComparison(parsed.records, false);
    A.showToast(`${parsed.records.length}개 번호를 확인했습니다.`);
  }

  function loadHistoryIntoBatch() {
    if (!S.history.length) return A.showToast("자동 발급 기록이 없습니다.");
    el.batch.value = S.history.map(A.formatRecordNumbers).join("\n");
    A.showToast(`${S.history.length}개 발급 기록을 넣었습니다.`);
  }

  function onComplete(numbers, max) {
    L.completed = true;
    L.numbers = numbers.filter(Number.isFinite);
    L.max = max;
    setInputsDisabled(false);
    el.progress.textContent = "추첨 완료";
    el.recheckStored.disabled = false;
    A.el.stageStatus.textContent = `실시간 추첨 완료 · ${A.formatRecordNumbers({ max: L.max, numbers: L.numbers })}`;
    renderComparison(S.history, true);
  }

  function onTabActivated() {
    if (L.completed && L.numbers.length === L.count) {
      restoreCompletedStage();
      renderComparison(S.history, true);
    } else {
      restoreIdleStage();
    }
  }

  function refreshComparison() {
    if (L.completed) renderComparison(S.history, true);
  }

  function init() {
    loadSettings();
    el.max.value = String(L.max);
    el.count.value = String(L.count);
    buildResultCells();
    clearComparison();

    el.max.addEventListener("change", normalizeSettings);
    el.count.addEventListener("change", normalizeSettings);
    el.recheckStored.addEventListener("click", compareStored);
    el.loadHistory.addEventListener("click", loadHistoryIntoBatch);
    el.checkBatch.addEventListener("click", checkBatch);
    el.clearBatch.addEventListener("click", () => {
      el.batch.value = "";
      el.batch.focus();
    });
  }

  A.live = {
    init,
    toggle,
    onReelStopped,
    onComplete,
    onTabActivated,
    refreshComparison,
    isCompleted: () => L.completed
  };
})();
