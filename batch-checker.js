(() => {
  "use strict";

  const HISTORY_STORAGE_KEY = "lucky-mouth-roulette.history.v1";
  const DEFAULT_MAX = 45;
  const MAX_REELS = 7;

  const batchRecords = document.getElementById("batchRecords");
  const loadSavedHistoryButton = document.getElementById("loadSavedHistoryButton");
  const checkPastedRecordsButton = document.getElementById("checkPastedRecordsButton");
  const clearBatchRecordsButton = document.getElementById("clearBatchRecordsButton");
  const winningNumbersInput = document.getElementById("winningNumbers");
  const bonusNumberInput = document.getElementById("bonusNumber");
  const checkerSummary = document.getElementById("checkerSummary");
  const checkedCount = document.getElementById("checkedCount");
  const bestResult = document.getElementById("bestResult");
  const prizeCount = document.getElementById("prizeCount");
  const checkerResults = document.getElementById("checkerResults");
  const emptyChecker = document.getElementById("emptyChecker");
  const toast = document.getElementById("toast");

  if (!batchRecords || !checkPastedRecordsButton) return;

  let toastTimer = 0;

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

  function parseWinningNumbers() {
    return parseNumberList(winningNumbersInput?.value, "당첨 번호");
  }

  function parseBonus(mainNumbers) {
    const raw = String(bonusNumberInput?.value || "").trim();
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

      const max = Math.max(DEFAULT_MAX, ...parsed.numbers);
      records.push({ max, numbers: parsed.numbers });
    }

    return { records };
  }

  function evaluateRecord(record, winningNumbers, bonus) {
    const mainSet = new Set(winningNumbers);
    const matched = record.numbers.filter((n) => mainSet.has(n));
    const bonusHit = bonus != null && record.numbers.includes(bonus);
    const standardLotto = winningNumbers.length === 6 && record.numbers.length === 6;

    let rank;
    let isPrize;

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

  function formatNumber(value, max) {
    const width = Math.max(1, String(Math.max(1, max || DEFAULT_MAX)).length);
    return String(value).padStart(width, "0");
  }

  function renderResults(records, winningNumbers, bonus) {
    const evaluations = records.map((record) => evaluateRecord(record, winningNumbers, bonus));
    let bestIndex = 0;

    for (let i = 1; i < evaluations.length; i++) {
      if (rankScore(evaluations[i]) > rankScore(evaluations[bestIndex])) bestIndex = i;
    }

    const best = evaluations[bestIndex];
    const standardMode = winningNumbers.length === 6 && records.some((record) => record.numbers.length === 6);
    const prizes = evaluations.filter((result) => result.isPrize).length;

    checkedCount.textContent = String(records.length);
    bestResult.textContent = best.rank;
    prizeCount.textContent = standardMode ? String(prizes) : `${prizes}개`;
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
      rank.className = `checker-rank${result.rank === "낙첨" || result.matchCount === 0 ? " miss" : ""}`;
      rank.textContent = `#${index + 1} · ${result.rank}`;

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
        pill.textContent = formatNumber(number, record.max);
        if (winningNumbers.includes(number)) pill.classList.add("match");
        if (bonus != null && number === bonus) pill.classList.add("bonus-match");
        numberRow.appendChild(pill);
      });

      li.append(head, numberRow);
      checkerResults.appendChild(li);
    });
  }

  function runPastedChecker() {
    const winning = parseWinningNumbers();
    if (winning.error) return showToast(winning.error);

    const bonusResult = parseBonus(winning.numbers);
    if (bonusResult.error) return showToast(bonusResult.error);

    const parsedBatch = parseBatch(batchRecords.value);
    if (parsedBatch.error) return showToast(parsedBatch.error);

    renderResults(parsedBatch.records, winning.numbers, bonusResult.bonus);
    showToast(`${parsedBatch.records.length}개 기록을 확인했습니다.`);
  }

  function loadSavedHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed) || !parsed.length) {
        showToast("저장된 추첨 기록이 없습니다.");
        return;
      }

      const lines = parsed
        .filter((record) => record && Array.isArray(record.numbers) && record.numbers.length)
        .map((record) => {
          const max = Number.isFinite(record.max) ? record.max : DEFAULT_MAX;
          return record.numbers.map((n) => formatNumber(Number(n), max)).join("  ");
        });

      if (!lines.length) {
        showToast("불러올 수 있는 추첨 기록이 없습니다.");
        return;
      }

      batchRecords.value = lines.join("\n");
      showToast(`${lines.length}개 기록을 불러왔습니다.`);
    } catch {
      showToast("추첨 기록을 불러오지 못했습니다.");
    }
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1800);
  }

  loadSavedHistoryButton?.addEventListener("click", loadSavedHistory);
  checkPastedRecordsButton.addEventListener("click", runPastedChecker);
  clearBatchRecordsButton?.addEventListener("click", () => {
    batchRecords.value = "";
    batchRecords.focus();
  });
})();
