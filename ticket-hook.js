(() => {
  "use strict";

  const A = window.MyaLotto;
  const S = A.state;
  if (!A?.ticket || typeof A.finalizeDraw !== "function") return;

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

    if (record) A.ticket.enqueue(record);
  };
})();
