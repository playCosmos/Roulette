(() => {
  "use strict";

  const A = window.MyaLotto;
  if (!A?.state || !A?.el?.stage) return;

  const S = A.state;
  const stage = A.el.stage;
  let opened = stage.classList.contains("mouth-open");

  function revealWhenSpinning() {
    if (opened || S.appState !== "spinning") return;
    opened = true;
    stage.classList.add("mouth-open");
  }

  function wrapAction(owner, key) {
    const original = owner?.[key];
    if (typeof original !== "function") return;

    owner[key] = (...args) => {
      const result = original(...args);
      revealWhenSpinning();
      return result;
    };
  }

  wrapAction(A.draw, "toggleDraw");
  wrapAction(A.live, "toggle");
})();
