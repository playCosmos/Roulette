(() => {
  "use strict";

  const A = window.MyaLotto;
  const S = A.state;
  const E = A.el;

  function isBusy() {
    return S.autoDrawRunning || ["spinning", "stopping", "manual"].includes(S.appState);
  }

  function isFormTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return target.matches("input, textarea, select, button");
  }

  function handleStageAction() {
    if (S.activeTab === "draw") A.draw.toggleDraw();
    else A.prepared?.toggle?.();
  }

  function restoreAutomaticStageContext() {
    const count = A.draw.getDrawCount();
    const max = A.draw.getMaxNumber();
    const mode = A.draw.getDrawMode();
    const autoRuns = A.draw.getAutoDrawCount();

    S.visibleReelCount = count;
    S.activeReels = Array.from({ length: count }, (_, index) => index);
    S.currentDrawSettings = { max, count, mode, autoRuns };
    S.currentResult = S.lastAutoResult?.slice?.() || [];
    S.appState = S.currentResult.length ? "result" : "idle";
    A.reels.forEach((reel) => reel.reset());
  }

  function switchTab(tabName) {
    const nextTab = tabName === "check" ? "check" : "draw";
    if (nextTab !== S.activeTab && isBusy()) {
      A.showToast("진행 중인 작업을 완료한 뒤 탭을 변경하세요.");
      return;
    }

    S.activeTab = nextTab;
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
      restoreAutomaticStageContext();
      E.stage.setAttribute("aria-label", "자동 번호 발급 시작 또는 정지");
      E.stageStatus.textContent = S.lastAutoResult.length
        ? `최근 발급 · ${A.formatRecordNumbers({ max: A.draw.getMaxNumber(), numbers: S.lastAutoResult })}`
        : A.draw.getIdleStatus(A.draw.getDrawMode(), A.draw.getDrawCount(), A.draw.getAutoDrawCount());
    } else {
      E.stage.setAttribute("aria-label", "미리 만든 번호를 하나씩 추첨");
      A.prepared?.onTabActivated?.();
    }
  }

  function bindEvents() {
    E.stage.addEventListener("click", handleStageAction);

    E.stage.addEventListener("keydown", (event) => {
      if (event.code !== "Enter" || event.repeat) return;
      event.preventDefault();
      handleStageAction();
    });

    window.addEventListener("keydown", (event) => {
      if (event.code !== "Space" || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isFormTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      handleStageAction();
    }, true);

    window.addEventListener("keyup", (event) => {
      if (event.code !== "Space") return;
      if (isFormTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);

    E.copyCurrentButton.addEventListener("click", () => {
      if (!S.lastAutoResult.length) return;
      A.copyText(
        A.formatRecordNumbers({ max: A.draw.getMaxNumber(), numbers: S.lastAutoResult }),
        "이번 발급 번호를 복사했습니다."
      );
    });

    E.copyAllButton.addEventListener("click", () => {
      if (!S.history.length) return;
      A.copyText(S.history.map(A.formatRecordNumbers).join("\n"), "전체 발급 번호를 복사했습니다.");
    });

    E.clearHistoryButton.addEventListener("click", () => {
      if (!S.history.length) return;
      if (!window.confirm("자동 발급 기록을 모두 초기화할까요?")) return;
      S.history = [];
      A.draw.saveHistory();
      A.draw.renderHistory();
      A.prepared?.onHistoryChanged?.();
      A.showToast("자동 발급 기록을 초기화했습니다.");
    });

    E.maxNumberInput.addEventListener("change", A.draw.normalizeAndSaveSettings);
    E.drawCountInput.addEventListener("change", A.draw.normalizeAndSaveSettings);
    E.autoDrawCountInput.addEventListener("change", A.draw.normalizeAndSaveSettings);
    E.drawModeInputs.forEach((input) => input.addEventListener("change", A.draw.normalizeAndSaveSettings));

    E.tabButtons.forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.tab));
    });
  }

  A.initDraw();
  A.prepared?.init?.();
  bindEvents();
  switchTab("draw");
  A.startAnimation();
})();
