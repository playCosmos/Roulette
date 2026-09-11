(() => {
  "use strict";

  const A = window.MyaLotto;
  const S = A.state;
  const STORAGE_KEY = "mya-lotto.prepared-draw.v1";

  const el = {
    editor: document.getElementById("preparedEditor"),
    numbers: document.getElementById("preparedNumbers"),
    useBonus: document.getElementById("preparedUseBonus"),
    bonusField: document.getElementById("preparedBonusField"),
    bonus: document.getElementById("preparedBonusNumber"),
    prepare: document.getElementById("prepareDrawButton"),
    ready: document.getElementById("preparedReady"),
    readyText: document.getElementById("preparedReadyText"),
    edit: document.getElementById("editPreparedButton"),
    resultNumbers: document.getElementById("preparedResultNumbers"),
    progress: document.getElementById("preparedProgress"),
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

  const P = {
    ready: false,
    completed: false,
    mainNumbers: [],
    bonus: null,
    targets: [],
    max: A.DEFAULT_MAX
  };

  function parseNumberList(raw, label = "추첨 번호", maxCount = A.MAX_REELS) {
    const tokens = String(raw || "").trim().split(/[\s,;]+/).filter(Boolean);
    if (tokens.length < 1 || tokens.length > maxCount) {
      return { error: `${label}는 1~${maxCount}개를 입력하세요.` };
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

  function readPreparedInput() {
    const main = parseNumberList(el.numbers.value, "추첨 번호", el.useBonus.checked ? 6 : A.MAX_REELS);
    if (main.error) return main;

    if (el.useBonus.checked && main.numbers.length !== 6) {
      return { error: "보너스 번호를 사용할 때는 기본 당첨 번호를 정확히 6개 입력하세요." };
    }

    let bonus = null;
    if (el.useBonus.checked) {
      bonus = Number.parseInt(el.bonus.value, 10);
      if (!Number.isFinite(bonus) || bonus < 1 || bonus > 999) {
        return { error: "보너스 번호를 1~999 사이에서 입력하세요." };
      }
      if (main.numbers.includes(bonus)) {
        return { error: "보너스 번호는 기본 당첨 번호와 중복될 수 없습니다." };
      }
    }

    const targets = bonus == null ? main.numbers.slice() : [...main.numbers, bonus];
    return {
      mainNumbers: main.numbers,
      bonus,
      targets,
      max: Math.max(A.DEFAULT_MAX, ...targets)
    };
  }

  function saveInput() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        numbers: el.numbers.value.trim(),
        useBonus: el.useBonus.checked,
        bonus: el.bonus.value.trim()
      }));
    } catch {
      // 저장 실패가 추첨 기능을 막지는 않는다.
    }
  }

  function loadInput() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") return;
      el.numbers.value = typeof parsed.numbers === "string" ? parsed.numbers : "";
      el.useBonus.checked = Boolean(parsed.useBonus);
      el.bonus.value = typeof parsed.bonus === "string" ? parsed.bonus : "";
    } catch {
      // 기본값 유지
    }
  }

  function applyBonusUi() {
    const enabled = el.useBonus.checked;
    el.bonus.disabled = !enabled;
    el.bonus.placeholder = enabled ? "예: 17" : "미사용";
    el.bonusField.classList.toggle("bonus-field-disabled", !enabled);
    saveInput();
  }

  function buildPreparedCells(count) {
    A.draw.buildResultCells(count, el.resultNumbers);
    if (P.bonus != null && el.resultNumbers.lastElementChild) {
      el.resultNumbers.lastElementChild.classList.add("bonus-result");
    }
  }

  function resetStageForPrepared() {
    S.appState = "idle";
    S.currentResult = [];
    S.currentDrawSettings = { max: P.max, count: P.targets.length, mode: "prepared", autoRuns: 1 };
    S.visibleReelCount = P.targets.length;
    S.activeReels = Array.from({ length: P.targets.length }, (_, index) => index);
    S.manualNextIndex = 0;
    S.manualStopPending = false;
    A.reels.forEach((reel) => reel.reset());
    buildPreparedCells(P.targets.length);
    el.progress.textContent = "준비 완료";
    A.el.stageStatus.textContent = `${P.targets.length}개 번호 준비됨 · 이미지 클릭 또는 Space로 회전 시작`;
  }

  function prepareDraw() {
    if (S.autoDrawRunning || ["spinning", "stopping", "manual"].includes(S.appState)) {
      A.showToast("진행 중인 추첨을 먼저 완료하세요.");
      return;
    }

    const parsed = readPreparedInput();
    if (parsed.error) return A.showToast(parsed.error);

    Object.assign(P, parsed, { ready: true, completed: false });
    saveInput();
    el.editor.hidden = true;
    el.ready.hidden = false;
    el.readyText.textContent = P.bonus == null
      ? `${P.targets.length}개 번호 준비됨`
      : "당첨 번호 6개 + 보너스 1개 준비됨";
    el.recheckStored.disabled = true;
    el.summary.hidden = true;
    el.results.textContent = "";
    el.empty.hidden = false;
    el.empty.textContent = "추첨을 완료하면 자동 발급 기록과 바로 비교합니다.";
    resetStageForPrepared();
  }

  function editPrepared() {
    if (["spinning", "stopping", "manual"].includes(S.appState)) {
      A.showToast("진행 중인 추첨을 먼저 완료하세요.");
      return;
    }
    P.ready = false;
    P.completed = false;
    el.editor.hidden = false;
    el.ready.hidden = true;
    el.progress.textContent = "준비 전";
    el.recheckStored.disabled = true;
    el.summary.hidden = true;
    el.results.textContent = "";
    el.empty.hidden = false;
    el.empty.textContent = "추첨을 완료하면 자동 발급 기록과 바로 비교합니다.";
    S.appState = "idle";
    S.currentResult = [];
    A.reels.forEach((reel) => reel.reset());
    A.el.stageStatus.textContent = "미리 만든 번호를 입력하고 추첨 준비를 눌러주세요.";
    el.numbers.focus();
  }

  function toggle() {
    if (S.activeTab !== "check") return;
    if (!P.ready) {
      A.showToast("먼저 미리 만든 번호를 입력하고 추첨 준비를 눌러주세요.");
      return;
    }

    if (["idle", "result"].includes(S.appState)) {
      P.completed = false;
      A.draw.beginPrepared(P.targets, P.max);
      return;
    }

    if (["spinning", "manual"].includes(S.appState) && S.currentDrawSettings?.mode === "prepared") {
      A.draw.stopNextPrepared();
    }
  }

  function onSpinStarted() {
    buildPreparedCells(P.targets.length);
    el.progress.textContent = `0/${P.targets.length} 공개`;
    el.summary.hidden = true;
    el.results.textContent = "";
    el.empty.hidden = false;
    el.empty.textContent = "모든 번호 공개 후 자동 발급 기록을 비교합니다.";
  }

  function onReelStopped(index, value) {
    const cell = el.resultNumbers.children[index];
    if (cell) {
      cell.textContent = A.formatDisplayNumber(value, P.max);
      if (P.bonus != null && index === P.targets.length - 1) cell.classList.add("bonus-result");
      cell.classList.remove("pop");
      void cell.offsetWidth;
      cell.classList.add("pop");
    }
    el.progress.textContent = `${index + 1}/${P.targets.length} 공개`;
  }

  function evaluateRecord(record) {
    const mainSet = new Set(P.mainNumbers);
    const matched = record.numbers.filter((number) => mainSet.has(number));
    const bonusHit = P.bonus != null && record.numbers.includes(P.bonus);
    const official = P.bonus != null && P.mainNumbers.length === 6 && record.numbers.length === 6;
    let rank;
    let isPrize;

    if (official) {
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

    return { matched, matchCount: matched.length, bonusHit, official, rank, isPrize };
  }

  function score(result) {
    if (result.official) {
      return ({ "1등": 100, "2등": 90, "3등": 80, "4등": 70, "5등": 60, "낙첨": 0 })[result.rank] || 0;
    }
    return result.matchCount * 10 + (result.bonusHit ? 1 : 0);
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
      if (score(evaluations[i]) > score(evaluations[bestIndex])) bestIndex = i;
    }

    const best = evaluations[bestIndex];
    const officialMode = P.bonus != null && P.mainNumbers.length === 6 && records.some((record) => record.numbers.length === 6);
    const hitRecords = evaluations.filter((result) => result.isPrize).length;

    el.checkedCount.textContent = String(records.length);
    el.bestResult.textContent = best.rank;
    el.prizeCountLabel.textContent = officialMode ? "당첨 기록" : "일치 기록";
    el.prizeCount.textContent = officialMode ? String(hitRecords) : `${hitRecords}개`;
    el.summary.hidden = false;
    el.empty.hidden = true;

    records.forEach((record, index) => {
      const result = evaluations[index];
      const li = document.createElement("li");
      li.className = "checker-result-item";

      const head = document.createElement("div");
      head.className = "checker-result-head";

      const rank = document.createElement("span");
      rank.className = `checker-rank${result.rank === "낙첨" || result.matchCount === 0 ? " miss" : ""}`;
      const displayIndex = reverseNumbering ? records.length - index : index + 1;
      rank.textContent = `#${displayIndex} · ${result.rank}`;

      const count = document.createElement("span");
      count.className = "match-count";
      count.textContent = result.bonusHit
        ? `일치 ${result.matchCount}개 + 보너스`
        : `일치 ${result.matchCount}개`;
      head.append(rank, count);

      const numberRow = document.createElement("div");
      numberRow.className = "checker-number-row";
      record.numbers.forEach((number) => {
        const pill = document.createElement("span");
        pill.className = "checker-number";
        pill.textContent = A.formatDisplayNumber(number, record.max);
        if (P.mainNumbers.includes(number)) pill.classList.add("match");
        if (P.bonus != null && number === P.bonus) pill.classList.add("bonus-match");
        numberRow.appendChild(pill);
      });

      li.append(head, numberRow);
      el.results.appendChild(li);
    });
  }

  function compareStored() {
    if (!P.completed) return A.showToast("먼저 추첨을 완료하세요.");
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
    if (!P.completed) return A.showToast("먼저 추첨을 완료하세요.");
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

  function onComplete(targets, max) {
    P.completed = true;
    P.max = max;
    el.progress.textContent = "추첨 완료";
    el.recheckStored.disabled = false;
    A.el.stageStatus.textContent = P.bonus == null
      ? `추첨 완료 · ${P.mainNumbers.length}개 번호 공개`
      : "추첨 완료 · 당첨 번호 6개 + 보너스 공개";
    renderComparison(S.history, true);
  }

  function onTabActivated() {
    if (!P.ready) {
      A.el.stageStatus.textContent = "미리 만든 번호를 입력하고 추첨 준비를 눌러주세요.";
      return;
    }
    if (S.currentDrawSettings?.mode === "prepared" && ["spinning", "manual"].includes(S.appState)) return;
    if (P.completed) {
      A.el.stageStatus.textContent = P.bonus == null
        ? `추첨 완료 · ${P.mainNumbers.length}개 번호 공개`
        : "추첨 완료 · 당첨 번호 6개 + 보너스 공개";
      renderComparison(S.history, true);
    } else {
      A.el.stageStatus.textContent = `${P.targets.length}개 번호 준비됨 · 이미지 클릭 또는 Space로 회전 시작`;
    }
  }

  function init() {
    loadInput();
    applyBonusUi();
    el.editor.hidden = false;
    el.ready.hidden = true;
    el.progress.textContent = "준비 전";
    A.draw.buildResultCells(A.DEFAULT_COUNT, el.resultNumbers);

    el.useBonus.addEventListener("change", applyBonusUi);
    el.numbers.addEventListener("change", saveInput);
    el.bonus.addEventListener("change", saveInput);
    el.prepare.addEventListener("click", prepareDraw);
    el.edit.addEventListener("click", editPrepared);
    el.recheckStored.addEventListener("click", compareStored);
    el.loadHistory.addEventListener("click", loadHistoryIntoBatch);
    el.checkBatch.addEventListener("click", checkBatch);
    el.clearBatch.addEventListener("click", () => {
      el.batch.value = "";
      el.batch.focus();
    });

    el.numbers.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      prepareDraw();
    });
  }

  A.prepared = {
    init,
    toggle,
    onSpinStarted,
    onReelStopped,
    onComplete,
    onTabActivated,
    onHistoryChanged: () => {
      if (P.completed) renderComparison(S.history, true);
    },
    isReady: () => P.ready,
    isCompleted: () => P.completed
  };
})();
