(() => {
  "use strict";

  const HISTORY_STORAGE_KEY = "lucky-mouth-roulette.history.v1";
  const CHECKER_STORAGE_KEY = "mya-lotto.checker.v1";
  const BONUS_MODE_STORAGE_KEY = "mya-lotto.bonus-mode.v1";
  const DEFAULT_MAX = 45;
  const MAX_REELS = 7;

  const useBonusMode = document.getElementById("useBonusMode");
  const bonusField = document.getElementById("bonusField");
  const bonusNumberInput = document.getElementById("bonusNumber");
  const winningNumbersInput = document.getElementById("winningNumbers");
  const checkNumbersButton = document.getElementById("checkNumbersButton");
  const checkPastedRecordsButton = document.getElementById("checkPastedRecordsButton");
  const batchRecords = document.getElementById("batchRecords");
  const checkerHelp = document.getElementById("checkerHelp");
  const checkerSummary = document.getElementById("checkerSummary");
  const checkedCount = document.getElementById("checkedCount");
  const bestResult = document.getElementById("bestResult");
  const prizeCount = document.getElementById("prizeCount");
  const prizeCountLabel = document.getElementById("prizeCountLabel");
  const checkerResults = document.getElementById("checkerResults");
  const emptyChecker = document.getElementById("emptyChecker");
  const toast = document.getElementById("toast");

  if (!useBonusMode || !winningNumbersInput || !bonusNumberInput) return;

  let toastTimer = 0;

  function loadBonusMode() {
    try {
      return localStorage.getItem(BONUS_MODE_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  }

  function saveBonusMode(enabled) {
    try {
      localStorage.setItem(BONUS_MODE_STORAGE_KEY, String(Boolean(enabled)));
    } catch {
      // 설정 저장 실패는 기능 자체를 막지 않는다.
    }
  }

  function saveCheckerInput() {
    try {
      localStorage.setItem(CHECKER_STORAGE_KEY, JSON.stringify({
        winningNumbers: winningNumbersInput.value.trim(),
        bonusNumber: bonusNumberInput.value.trim()
      }));
    } catch {
      // 입력값 저장 실패는 검사 기능 자체를 막지 않는다.
    }
  }

  function applyBonusMode(enabled, clearResults = false) {
    useBonusMode.checked = Boolean(enabled);
    bonusNumberInput.disabled = !enabled;
    bonusNumberInput.placeholder = enabled ? "예: 17" : "미사용";
    bonusField?.classList.toggle("bonus-field-disabled", !enabled);

    if (checkerHelp) {
      checkerHelp.textContent = enabled
        ? "당첨 번호 6개와 보너스 번호를 모두 입력하면 로또 방식으로 1~5등을 판정합니다."
        : "보너스 번호를 사용하지 않으면 등수 대신 각 기록에서 몇 개가 일치했는지만 표시합니다.";
    }

    if (prizeCountLabel) {
      prizeCountLabel.textContent = enabled ? "당첨 기록" : "일치 기록";
    }

    if (clearResults) {
      checkerResults.textContent = "";
      checkerSummary.hidden = true;
      emptyChecker.hidden = false;
      emptyChecker.textContent = "당첨 번호를 입력하고 기록 확인을 눌러주세요.";
    }
  }

  function parseNumberList(raw, label, maxCount = MAX_REELS) {
    const tokens = String(raw || "")
      .trim()
      .split(/[\s,;]+/)
      .filter(Boolean);

    if (tokens.length < 1 || tokens.length > maxCount) {
      return { error: `${label}는 1~${maxCount}개를 입력하세요.` };
    }

    const numbers = tokens.map((token) => Number.parseInt(token, 10));
    if (numbers.some((n) => !Number.isFinite(n) || n < 1 || n > 999)) {
      return { error: `${label}에는 1~999 사이의 숫자만 사용할 수 있습니다.` };
    }

    if (new Set(numbers).size !== numbers.length) {
      return { error: `${label}에는 중복 숫자를 사용할 수 없습니다.` };
    }

    return { numbers };
  }

  function loadStoredRecords() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((record) => record && Array.isArray(record.numbers) && record.numbers.length)
        .map((record) => ({
          max: Number.isFinite(record.max) ? record.max : DEFAULT_MAX,
          numbers: record.numbers.map(Number).filter(Number.isFinite)
        }))
        .filter((record) => record.numbers.length >= 1 && record.numbers.length <= MAX_REELS);
    } catch {
      return [];
    }
  }

  function parseBatch(raw) {
    const lines = String(raw || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) return { error: "검사할 추첨 기록을 붙여넣어 주세요." };

    const records = [];
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseNumberList(lines[i], `${i + 1}번째 줄`);
      if (parsed.error) return { error: parsed.error };
      records.push({
        max: Math.max(DEFAULT_MAX, ...parsed.numbers),
        numbers: parsed.numbers
      });
    }

    return { records };
  }

  function formatNumber(value, max) {
    const width = Math.max(1, String(Math.max(1, max || DEFAULT_MAX)).length);
    return String(value).padStart(width, "0");
  }

  function evaluateMatchOnly(record, winningNumbers) {
    const winningSet = new Set(winningNumbers);
    const matched = record.numbers.filter((number) => winningSet.has(number));
    return {
      matched,
      matchCount: matched.length,
      rank: `${matched.length}개 일치`
    };
  }

  function renderMatchOnly(records, winningNumbers, reverseHistoryNumbering) {
    if (!records.length) {
      checkerResults.textContent = "";
      checkerSummary.hidden = true;
      emptyChecker.hidden = false;
      emptyChecker.textContent = "비교할 추첨 기록이 없습니다.";
      return;
    }

    const evaluations = records.map((record) => evaluateMatchOnly(record, winningNumbers));
    const best = evaluations.reduce((current, result) => (
      result.matchCount > current.matchCount ? result : current
    ), evaluations[0]);
    const matchedRecords = evaluations.filter((result) => result.matchCount > 0).length;

    checkedCount.textContent = String(records.length);
    bestResult.textContent = best.rank;
    prizeCount.textContent = `${matchedRecords}개`;
    if (prizeCountLabel) prizeCountLabel.textContent = "일치 기록";
    checkerSummary.hidden = false;
    checkerResults.textContent = "";
    emptyChecker.hidden = true;

    records.forEach((record, index) => {
      const result = evaluations[index];
      const li = document.createElement("li");
      li.className = "checker-result-item";

      const head = document.createElement("div");
      head.className = "checker-result-head";

      const rank = document.createElement("span");
      rank.className = `checker-rank${result.matchCount === 0 ? " miss" : ""}`;
      const displayIndex = reverseHistoryNumbering ? records.length - index : index + 1;
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
        pill.textContent = formatNumber(number, record.max);
        if (winningNumbers.includes(number)) pill.classList.add("match");
        numberRow.appendChild(pill);
      });

      li.append(head, numberRow);
      checkerResults.appendChild(li);
    });
  }

  function runStoredMatchChecker() {
    const winning = parseNumberList(winningNumbersInput.value, "당첨 번호");
    if (winning.error) return showToast(winning.error);

    saveCheckerInput();
    renderMatchOnly(loadStoredRecords(), winning.numbers, true);
  }

  function runPastedMatchChecker() {
    const winning = parseNumberList(winningNumbersInput.value, "당첨 번호");
    if (winning.error) return showToast(winning.error);

    const parsedBatch = parseBatch(batchRecords?.value);
    if (parsedBatch.error) return showToast(parsedBatch.error);

    saveCheckerInput();
    renderMatchOnly(parsedBatch.records, winning.numbers, false);
    showToast(`${parsedBatch.records.length}개 기록을 확인했습니다.`);
  }

  function shouldInterceptOfficialCheck() {
    if (!useBonusMode.checked) return true;

    if (!bonusNumberInput.value.trim()) {
      showToast("보너스 번호 사용이 켜져 있습니다. 보너스 번호를 입력하세요.");
      return true;
    }

    return false;
  }

  function handleCheckAction(button) {
    if (!button) return false;

    if (useBonusMode.checked) {
      return shouldInterceptOfficialCheck();
    }

    if (button === checkNumbersButton) runStoredMatchChecker();
    else if (button === checkPastedRecordsButton) runPastedMatchChecker();
    return true;
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1800);
  }

  useBonusMode.addEventListener("change", () => {
    saveBonusMode(useBonusMode.checked);
    applyBonusMode(useBonusMode.checked, true);
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (target !== checkNumbersButton && target !== checkPastedRecordsButton) return;

    if (handleCheckAction(target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.target !== winningNumbersInput && event.target !== bonusNumberInput) return;

    if (!useBonusMode.checked) {
      event.preventDefault();
      event.stopImmediatePropagation();
      runStoredMatchChecker();
      return;
    }

    if (!bonusNumberInput.value.trim()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showToast("보너스 번호 사용이 켜져 있습니다. 보너스 번호를 입력하세요.");
    }
  }, true);

  applyBonusMode(loadBonusMode(), false);
})();
