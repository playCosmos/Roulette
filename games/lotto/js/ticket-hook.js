(() => {
  "use strict";

  const A = window.MyaLotto;
  const S = A.state;
  const E = A.el;
  if (!A?.ticket || typeof A.finalizeDraw !== "function") return;

  const maxInput = document.getElementById("maxNumber");
  const countInput = document.getElementById("drawCount");

  function syncTicketInputLock() {
    const busy = S.activeTab === "draw" && (
      S.autoDrawRunning || !["idle", "result"].includes(S.appState)
    );
    A.ticket.setDisabled?.(busy);
  }

  function ensureAutomaticTicketSettings(notify = true) {
    if (!A.ticket.isEnabled?.()) return false;
    if (A.draw?.getDrawMode?.() === "manual") return true;

    const max = Number.parseInt(maxInput?.value || "", 10);
    const count = Number.parseInt(countInput?.value || "", 10);
    if (max === 28 && count === 7) return true;

    if (maxInput) maxInput.value = "28";
    if (countInput) countInput.value = "7";

    // 이미지 시트가 1~28 / 7개 전용이므로 이미지 출력 ON일 때는
    // 무응답으로 건너뛰지 않고 실제 발급 설정도 호환 규격으로 맞춘다.
    A.draw?.normalizeAndSaveSettings?.();
    A.ticket.refreshHint?.();

    if (notify) {
      A.showToast("이미지 출력 규격에 맞춰 번호 범위를 1~28, 발급 개수를 7개로 맞췄습니다.");
    }
    return true;
  }

  const originalFinalizeDraw = A.finalizeDraw;
  A.finalizeDraw = () => {
    const ticketEnabled = Boolean(A.ticket.isEnabled?.());
    const shouldIssueTicket =
      ticketEnabled &&
      ["stopping", "manual"].includes(S.appState) &&
      S.currentDrawSettings?.mode !== "live" &&
      Array.isArray(S.currentResult) &&
      S.currentResult.length > 0;

    const record = shouldIssueTicket
      ? {
          max: Number(S.currentDrawSettings?.max),
          numbers: S.currentResult.slice()
        }
      : null;

    originalFinalizeDraw();
    syncTicketInputLock();

    if (!record) return;

    const completedStatus = E.stageStatus?.textContent || "발급 완료";
    if (E.stageStatus) E.stageStatus.textContent = `${completedStatus} · 티켓 PNG 생성 중`;

    A.ticket.enqueue(record).then((templateId) => {
      if (templateId) {
        A.showToast(`티켓 PNG 다운로드 요청 완료 · ${templateId}`);
        if (E.stageStatus) E.stageStatus.textContent = `${completedStatus} · 티켓 PNG 요청 완료`;
        return;
      }

      A.showToast("티켓 PNG가 생성되지 않았습니다. 이미지 출력 설정과 브라우저 다운로드 권한을 확인하세요.");
      if (E.stageStatus) E.stageStatus.textContent = `${completedStatus} · 티켓 PNG 생성 실패`;
    }).catch((error) => {
      console.error(error);
      A.showToast("티켓 PNG 생성 중 오류가 발생했습니다. 개발자 콘솔을 확인하세요.");
      if (E.stageStatus) E.stageStatus.textContent = `${completedStatus} · 티켓 PNG 오류`;
    });
  };

  if (A.draw && typeof A.draw.toggleDraw === "function") {
    const originalToggleDraw = A.draw.toggleDraw;
    A.draw.toggleDraw = (...args) => {
      ensureAutomaticTicketSettings(true);
      const result = originalToggleDraw(...args);
      syncTicketInputLock();
      return result;
    };
  }

  requestAnimationFrame(() => {
    // 이전 세션에서 이미지 출력이 켜져 있었지만 자동 발급 설정이 45/7 등으로
    // 남아 있던 경우도 첫 화면에서 즉시 28/7로 복구한다.
    ensureAutomaticTicketSettings(false);
    A.ticket.refreshHint?.();
    syncTicketInputLock();
  });
})();
