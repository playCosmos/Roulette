(() => {
  "use strict";

  const A = window.MyaLotto;
  const S = A.state;
  const E = A.el;

  function loadCheckerState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(A.CHECKER_STORAGE_KEY) || "null");
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
      localStorage.setItem(A.CHECKER_STORAGE_KEY, JSON.stringify(state));
    } catch {
      A.showToast("당첨 번호를 브라우저에 저장하지 못했습니다.");
    }
  }

  function parseWinningNumbers(raw) {
    const tokens = String(raw || "").trim().split(/[\s,;]+/).filter(Boolean);
    if (tokens.length < 1 || tokens.length > A.MAX_REELS) {
      return { error: `당첨 번호는 1~${A.MAX_REELS}개를 입력하세요.` };
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
    const raw = E.bonusNumberInput.value.trim();
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

    return { matched, matchCount: matched.length, bonusHit, standardLotto, rank, isPrize };
  }

  function rankScore(result) {
    if (result.standardLotto) {
      const scores = { "1등": 100, "2등": 90, "3등": 80, "4등": 70, "5등": 60, "낙첨": 0 };
      return scores[result.rank] || 0;
    }
    return result.matchCount * 10 + (result.bonusHit ? 1 : 0);
  }

  function renderCheckerResult(record, result, winningNumbers, bonus, displayIndex) {
    const li = document.createElement("li");
    li.className = "checker-result-item";

    const head = document.createElement("div");
    head.className = "checker-result-head";

    const rank = document.createElement("span");
    rank.className = `checker-rank${result.rank === "낙첨" || result.matchCount === 0 ? " miss" : ""}`;
    rank.textContent = `#${displayIndex} · ${result.rank}`;

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
      pill.textContent = A.formatDisplayNumber(number, record.max);
      if (winningNumbers.includes(number)) pill.classList.add("match");
      if (bonus != null && number === bonus) pill.classList.add("bonus-match");
      numberRow.appendChild(pill);
    });

    li.append(head, numberRow);
    E.checkerResults.appendChild(li);
  }

  function runChecker() {
    const parsed = parseWinningNumbers(E.winningNumbersInput.value);
    if (parsed.error) return A.showToast(parsed.error);
    const bonusResult = getBonusNumber(parsed.numbers);
    if (bonusResult.error) return A.showToast(bonusResult.error);

    const winningNumbers = parsed.numbers;
    const bonus = bonusResult.bonus;
    saveCheckerState({
      winningNumbers: winningNumbers.join(" "),
      bonusNumber: bonus == null ? "" : String(bonus)
    });

    E.checkerResults.textContent = "";
    if (!S.history.length) {
      E.checkerSummary.hidden = true;
      E.emptyChecker.hidden = false;
      E.emptyChecker.textContent = "비교할 추첨 기록이 없습니다.";
      return;
    }

    const evaluations = S.history.map((record) => evaluateRecord(record, winningNumbers, bonus));
    let bestIndex = 0;
    for (let i = 1; i < evaluations.length; i++) {
      if (rankScore(evaluations[i]) > rankScore(evaluations[bestIndex])) bestIndex = i;
    }

    const best = evaluations[bestIndex];
    const standardMode = winningNumbers.length === 6 && S.history.some((record) => record.numbers.length === 6);
    const prizes = evaluations.filter((result) => result.isPrize).length;
    E.checkedCount.textContent = String(S.history.length);
    E.bestResult.textContent = best.rank;
    E.prizeCount.textContent = standardMode ? String(prizes) : `${prizes}개`;
    E.checkerSummary.hidden = false;
    E.emptyChecker.hidden = true;

    S.history.forEach((record, index) => {
      renderCheckerResult(record, evaluations[index], winningNumbers, bonus, S.history.length - index);
    });
  }

  function switchTab(tabName) {
    S.activeTab = tabName === "check" ? "check" : "draw";
    E.tabButtons.forEach((button) => {
      const active = button.dataset.tab === S.activeTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });

    const drawActive = S.activeTab === "draw";
    E.drawPanel.hidden = !drawActive;
    E.drawPanel.classList.toggle("active", drawActive);
    E.checkPanel.hidden = drawActive;
    E.checkPanel.classList.toggle("active", !drawActive);

    if (drawActive) {
      E.stage.setAttribute("aria-label", "회전 시작 또는 정지");
      if (["spinning", "stopping", "manual"].includes(S.appState)) return;
      E.stageStatus.textContent = S.currentResult.length
        ? `완료 · ${A.formatRecordNumbers({ max: S.currentDrawSettings?.max || A.draw.getMaxNumber(), numbers: S.currentResult })}`
        : A.draw.getIdleStatus(A.draw.getDrawMode(), A.draw.getDrawCount(), A.draw.getAutoDrawCount());
    } else {
      E.stage.setAttribute("aria-label", "번호 확인 탭");
      E.stageStatus.textContent = "추첨 기록과 실제 당첨 번호 비교";
    }
  }

  function bindEvents() {
    E.stage.addEventListener("click", A.draw.toggleDraw);

    E.stage.addEventListener("keydown", (event) => {
      if (event.code !== "Enter" || event.repeat || S.activeTab !== "draw") return;
      event.preventDefault();
      A.draw.toggleDraw();
    });

    window.addEventListener("keydown", (event) => {
      if (event.code !== "Space" || event.repeat || S.activeTab !== "draw") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      A.draw.toggleDraw();
    }, true);

    window.addEventListener("keyup", (event) => {
      if (event.code !== "Space" || S.activeTab !== "draw") return;
      event.preventDefault();
      event.stopPropagation();
    }, true);

    E.copyCurrentButton.addEventListener("click", () => {
      if (!S.currentResult.length) return;
      A.copyText(
        A.formatRecordNumbers({ max: S.currentDrawSettings?.max || A.draw.getMaxNumber(), numbers: S.currentResult }),
        "이번 추첨 번호를 복사했습니다."
      );
    });

    E.copyAllButton.addEventListener("click", () => {
      if (!S.history.length) return;
      A.copyText(S.history.map(A.formatRecordNumbers).join("\n"), "전체 추첨 번호를 복사했습니다.");
    });

    E.clearHistoryButton.addEventListener("click", () => {
      if (!S.history.length) return;
      if (!window.confirm("추첨 기록을 모두 초기화할까요?")) return;
      S.history = [];
      A.draw.saveHistory();
      A.draw.renderHistory();
      E.checkerResults.textContent = "";
      E.checkerSummary.hidden = true;
      E.emptyChecker.hidden = false;
      E.emptyChecker.textContent = "비교할 추첨 기록이 없습니다.";
      A.showToast("추첨 기록을 초기화했습니다.");
    });

    E.maxNumberInput.addEventListener("change", A.draw.normalizeAndSaveSettings);
    E.drawCountInput.addEventListener("change", A.draw.normalizeAndSaveSettings);
    E.autoDrawCountInput.addEventListener("change", A.draw.normalizeAndSaveSettings);
    E.drawModeInputs.forEach((input) => input.addEventListener("change", A.draw.normalizeAndSaveSettings));

    E.tabButtons.forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.tab));
    });

    E.checkNumbersButton.addEventListener("click", runChecker);
    E.winningNumbersInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      runChecker();
    });
    E.bonusNumberInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      runChecker();
    });
  }

  const checker = loadCheckerState();
  E.winningNumbersInput.value = checker.winningNumbers || "";
  E.bonusNumberInput.value = checker.bonusNumber || "";

  A.initDraw();
  bindEvents();
  switchTab("draw");
  A.startAnimation();
})();