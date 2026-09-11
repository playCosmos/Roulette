(() => {
  "use strict";

  const A = window.MyaLotto;
  const S = A.state;
  if (!A?.ticket || typeof A.finalizeDraw !== "function") return;

  function syncTicketInputLock() {
    const busy = S.activeTab === "draw" && (
      S.autoDrawRunning || !["idle", "result"].includes(S.appState)
    );
    A.ticket.setDisabled?.(busy);
  }

  const originalFinalizeDraw = A.finalizeDraw;
  A.finalizeDraw = () => {
    const shouldIssueTicket =
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

    if (record) A.ticket.enqueue(record);
  };

  if (A.draw && typeof A.draw.toggleDraw === "function") {
    const originalToggleDraw = A.draw.toggleDraw;
    A.draw.toggleDraw = (...args) => {
      const result = originalToggleDraw(...args);
      syncTicketInputLock();
      return result;
    };
  }

  requestAnimationFrame(() => {
    A.ticket.refreshHint?.();
    syncTicketInputLock();
  });
})();
