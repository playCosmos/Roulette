(() => {
  "use strict";

  const A = window.MyaLotto;
  if (!A?.state || !A?.el?.stage) return;

  const S = A.state;
  const stage = A.el.stage;
  const frames = [...stage.querySelectorAll(".stage-transition-frame")];
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  // image0 → image1 → image2 → image3 → Frame3
  // 각 단계가 눈에 충분히 보이도록 이전 120ms 간격보다 크게 늘린다.
  const FRAME_TIMELINE = reducedMotion
    ? [55, 110, 165, 230]
    : [320, 680, 1060, 1480];
  const FINAL_FADE_MS = reducedMotion ? 45 : 280;

  let opened = stage.classList.contains("mouth-open");
  let playing = false;
  let currentFrame = 0;
  let timers = [];

  function clearTimers() {
    timers.forEach((timer) => window.clearTimeout(timer));
    timers = [];
  }

  function frameAvailable(index) {
    const frame = frames[index];
    return Boolean(frame && frame.dataset.loadFailed !== "true");
  }

  function showFrame(index) {
    currentFrame = index;
    frames.forEach((frame, frameIndex) => {
      frame.classList.toggle("active", frameIndex === index && frameAvailable(frameIndex));
    });
  }

  function showFirstAvailableFrame() {
    const next = frames.findIndex((frame) => frame.dataset.loadFailed !== "true" && frame.complete && frame.naturalWidth > 0);
    if (next >= 0) showFrame(next);
  }

  frames.forEach((frame, index) => {
    const onFailure = () => {
      frame.dataset.loadFailed = "true";
      frame.classList.remove("active");
      if (!opened && !playing && currentFrame === index) showFirstAvailableFrame();
    };

    if (frame.complete && frame.naturalWidth === 0) onFailure();
    else frame.addEventListener("error", onFailure, { once: true });

    frame.addEventListener("load", () => {
      if (!opened && !playing && frames[0]?.dataset.loadFailed === "true") showFirstAvailableFrame();
    }, { once: true });
  });

  function playOpeningSequence() {
    if (opened || playing || S.appState !== "spinning") return;

    playing = true;
    stage.classList.add("mouth-transitioning");

    [1, 2, 3].forEach((frameIndex, sequenceIndex) => {
      timers.push(window.setTimeout(() => {
        if (frameAvailable(frameIndex)) showFrame(frameIndex);
      }, FRAME_TIMELINE[sequenceIndex]));
    });

    // 마지막 image3를 충분히 보여준 뒤 Frame3가 아래에서 드러나게 한다.
    timers.push(window.setTimeout(() => {
      showFrame(-1);
      opened = true;
      stage.classList.add("mouth-open");

      timers.push(window.setTimeout(() => {
        playing = false;
        stage.classList.remove("mouth-transitioning");
        clearTimers();
      }, FINAL_FADE_MS));
    }, FRAME_TIMELINE[3]));
  }

  function wrapAction(owner, key) {
    const original = owner?.[key];
    if (typeof original !== "function") return;

    owner[key] = (...args) => {
      if (playing) return false;

      const previousState = S.appState;
      const result = original(...args);

      if (!opened && previousState !== "spinning" && S.appState === "spinning") {
        playOpeningSequence();
      }

      return result;
    };
  }

  showFrame(frameAvailable(0) ? 0 : -1);
  wrapAction(A.draw, "toggleDraw");
  wrapAction(A.live, "toggle");
})();
