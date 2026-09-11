(() => {
  "use strict";

  const A = window.MyaLotto;
  const S = A.state;
  const SETTINGS_STORAGE_KEY = "mya-lotto.live-draw.v1";
  const PARTICIPANTS_STORAGE_KEY = "mya-lotto.participants.v1";
  const MAX_PARTICIPANTS = 50;

  const el = {
    max: document.getElementById("liveMaxNumber"),
    count: document.getElementById("liveDrawCount"),
    resultNumbers: document.getElementById("liveResultNumbers"),
    progress: document.getElementById("liveProgress"),
    addParticipant: document.getElementById("addParticipantButton"),
    participantList: document.getElementById("participantList"),
    participantCount: document.getElementById("participantCount"),
    emptyParticipants: document.getElementById("emptyParticipants")
  };

  const L = {
    max: A.DEFAULT_MAX,
    count: A.DEFAULT_COUNT,
    completed: false,
    numbers: [],
    participants: []
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
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "null");
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
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ max: L.max, count: L.count }));
    } catch {
      // 설정 저장 실패는 추첨 자체를 막지 않는다.
    }
  }

  function createParticipantId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `p-${Date.now()}-${A.secureRandomInt(1000, 999999)}`;
  }

  function normalizeParticipant(raw, index) {
    return {
      id: typeof raw?.id === "string" && raw.id ? raw.id : createParticipantId(),
      name: typeof raw?.name === "string" && raw.name.trim() ? raw.name : `참가자 ${index + 1}`,
      numbersText: typeof raw?.numbersText === "string" ? raw.numbersText : ""
    };
  }

  function loadParticipants() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PARTICIPANTS_STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, MAX_PARTICIPANTS).map(normalizeParticipant);
    } catch {
      return [];
    }
  }

  function saveParticipants() {
    try {
      localStorage.setItem(PARTICIPANTS_STORAGE_KEY, JSON.stringify(L.participants));
    } catch {
      A.showToast("참가자 번호를 브라우저에 저장하지 못했습니다.");
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
    renderAllParticipantResults();

    if (S.activeTab === "check") restoreIdleStage();
  }

  function setInputsDisabled(disabled) {
    el.max.disabled = disabled;
    el.count.disabled = disabled;
  }

  function buildResultCells() {
    A.draw.buildResultCells(L.count, el.resultNumbers);
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

    buildResultCells();
    L.numbers.forEach((value, index) => {
      const cell = el.resultNumbers.children[index];
      if (cell) cell.textContent = A.formatDisplayNumber(value, L.max);
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
    renderAllParticipantResults();
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

  function parseTicketLine(raw, lineNumber) {
    const tokens = String(raw || "").trim().split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length) return { empty: true };
    if (tokens.length > A.MAX_REELS) {
      return { error: `${lineNumber}번째 줄은 최대 ${A.MAX_REELS}개까지 입력할 수 있습니다.` };
    }

    const numbers = tokens.map((token) => Number.parseInt(token, 10));
    if (numbers.some((number) => !Number.isFinite(number) || number < 1 || number > L.max)) {
      return { error: `${lineNumber}번째 줄에는 1~${L.max} 사이의 숫자만 사용할 수 있습니다.` };
    }
    if (new Set(numbers).size !== numbers.length) {
      return { error: `${lineNumber}번째 줄에 중복 번호가 있습니다.` };
    }

    return { numbers };
  }

  function parseParticipantTickets(participant) {
    const rawLines = String(participant.numbersText || "").split(/\r?\n/);
    const tickets = [];
    const errors = [];

    rawLines.forEach((line, index) => {
      if (!line.trim()) return;
      const parsed = parseTicketLine(line, index + 1);
      if (parsed.error) errors.push(parsed.error);
      else if (parsed.numbers) tickets.push({ lineNumber: index + 1, numbers: parsed.numbers });
    });

    return { tickets, errors };
  }

  function evaluateTicket(ticket) {
    const winningSet = new Set(L.numbers);
    const matched = ticket.numbers.filter((number) => winningSet.has(number));
    return {
      numbers: ticket.numbers,
      lineNumber: ticket.lineNumber,
      matched,
      matchCount: matched.length
    };
  }

  function createNumberPill(number, matched) {
    const pill = document.createElement("span");
    pill.className = `participant-number${matched ? " match" : ""}`;
    pill.textContent = A.formatDisplayNumber(number, L.max);
    return pill;
  }

  function renderParticipantResult(participant, resultRoot, summaryRoot) {
    resultRoot.textContent = "";
    const parsed = parseParticipantTickets(participant);

    if (!L.completed) {
      summaryRoot.textContent = parsed.tickets.length
        ? `${parsed.tickets.length}개 조합 · 추첨 대기`
        : "번호를 입력하세요";
      if (parsed.errors.length) summaryRoot.textContent += ` · 입력 오류 ${parsed.errors.length}줄`;
      return;
    }

    if (!parsed.tickets.length) {
      summaryRoot.textContent = parsed.errors.length ? "입력 오류" : "번호 없음";
      parsed.errors.forEach((message) => {
        const error = document.createElement("p");
        error.className = "participant-error";
        error.textContent = message;
        resultRoot.appendChild(error);
      });
      return;
    }

    const evaluations = parsed.tickets.map(evaluateTicket);
    const best = evaluations.reduce((max, result) => Math.max(max, result.matchCount), 0);
    const hitTickets = evaluations.filter((result) => result.matchCount > 0).length;
    summaryRoot.textContent = `최고 ${best}개 일치 · ${hitTickets}/${evaluations.length}조합 적중`;

    evaluations.forEach((result) => {
      const row = document.createElement("div");
      row.className = "participant-ticket-result";

      const head = document.createElement("div");
      head.className = "participant-ticket-head";

      const label = document.createElement("span");
      label.textContent = `${result.lineNumber}번 조합`;

      const score = document.createElement("strong");
      score.className = result.matchCount > 0 ? "has-match" : "";
      score.textContent = `${result.matchCount}개 일치`;
      head.append(label, score);

      const numbers = document.createElement("div");
      numbers.className = "participant-ticket-numbers";
      result.numbers.forEach((number) => {
        numbers.appendChild(createNumberPill(number, result.matched.includes(number)));
      });

      row.append(head, numbers);
      resultRoot.appendChild(row);
    });

    parsed.errors.forEach((message) => {
      const error = document.createElement("p");
      error.className = "participant-error";
      error.textContent = message;
      resultRoot.appendChild(error);
    });
  }

  function renderParticipantCard(participant, index) {
    const card = document.createElement("article");
    card.className = "participant-card";
    card.dataset.participantId = participant.id;

    const top = document.createElement("div");
    top.className = "participant-card-top";

    const nameWrap = document.createElement("label");
    nameWrap.className = "participant-name-field";
    const nameLabel = document.createElement("span");
    nameLabel.textContent = "이름";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 40;
    nameInput.value = participant.name;
    nameInput.placeholder = `참가자 ${index + 1}`;
    nameWrap.append(nameLabel, nameInput);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-button danger participant-remove";
    remove.textContent = "삭제";
    top.append(nameWrap, remove);

    const numberWrap = document.createElement("label");
    numberWrap.className = "participant-number-field";
    const numberLabel = document.createElement("span");
    numberLabel.textContent = "보유 번호";
    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    textarea.spellcheck = false;
    textarea.value = participant.numbersText;
    textarea.placeholder = "한 줄에 한 조합씩 입력\n03 08 12 21 34 42\n01 05 11 19 27 44";
    numberWrap.append(numberLabel, textarea);

    const resultHead = document.createElement("div");
    resultHead.className = "participant-result-head";
    const resultLabel = document.createElement("span");
    resultLabel.textContent = "결과";
    const resultSummary = document.createElement("strong");
    resultHead.append(resultLabel, resultSummary);

    const resultRoot = document.createElement("div");
    resultRoot.className = "participant-results";

    const sync = () => {
      participant.name = nameInput.value.trim() || `참가자 ${index + 1}`;
      participant.numbersText = textarea.value;
      saveParticipants();
      renderParticipantResult(participant, resultRoot, resultSummary);
    };

    nameInput.addEventListener("input", sync);
    textarea.addEventListener("input", sync);
    remove.addEventListener("click", () => removeParticipant(participant.id));

    card.append(top, numberWrap, resultHead, resultRoot);
    renderParticipantResult(participant, resultRoot, resultSummary);
    return card;
  }

  function renderParticipants() {
    el.participantList.textContent = "";
    el.participantCount.textContent = `${L.participants.length}명`;
    el.emptyParticipants.hidden = L.participants.length > 0;

    L.participants.forEach((participant, index) => {
      el.participantList.appendChild(renderParticipantCard(participant, index));
    });
  }

  function renderAllParticipantResults() {
    if (!el.participantList) return;
    const cards = [...el.participantList.querySelectorAll(".participant-card")];
    cards.forEach((card) => {
      const participant = L.participants.find((item) => item.id === card.dataset.participantId);
      if (!participant) return;
      const resultRoot = card.querySelector(".participant-results");
      const summaryRoot = card.querySelector(".participant-result-head strong");
      if (resultRoot && summaryRoot) renderParticipantResult(participant, resultRoot, summaryRoot);
    });
  }

  function addParticipant() {
    if (L.participants.length >= MAX_PARTICIPANTS) {
      A.showToast(`참가자는 최대 ${MAX_PARTICIPANTS}명까지 추가할 수 있습니다.`);
      return;
    }

    const participant = {
      id: createParticipantId(),
      name: `참가자 ${L.participants.length + 1}`,
      numbersText: ""
    };
    L.participants.push(participant);
    saveParticipants();
    renderParticipants();

    const card = el.participantList.lastElementChild;
    card?.querySelector(".participant-name-field input")?.focus();
  }

  function removeParticipant(id) {
    L.participants = L.participants.filter((participant) => participant.id !== id);
    saveParticipants();
    renderParticipants();
  }

  function onComplete(numbers, max) {
    L.completed = true;
    L.numbers = numbers.filter(Number.isFinite);
    L.max = max;
    setInputsDisabled(false);
    el.progress.textContent = "추첨 완료";
    A.el.stageStatus.textContent = `실시간 추첨 완료 · ${A.formatRecordNumbers({ max: L.max, numbers: L.numbers })}`;
    renderAllParticipantResults();
  }

  function onTabActivated() {
    if (L.completed && L.numbers.length === L.count) restoreCompletedStage();
    else restoreIdleStage();
    renderAllParticipantResults();
  }

  function refreshComparison() {
    renderAllParticipantResults();
  }

  function init() {
    loadSettings();
    L.participants = loadParticipants();
    el.max.value = String(L.max);
    el.count.value = String(L.count);
    buildResultCells();
    renderParticipants();

    el.max.addEventListener("change", normalizeSettings);
    el.count.addEventListener("change", normalizeSettings);
    el.addParticipant.addEventListener("click", addParticipant);
  }

  A.live = {
    init,
    toggle,
    onReelStopped,
    onComplete,
    onTabActivated,
    refreshComparison
  };
})();
