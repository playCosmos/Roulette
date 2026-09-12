(() => {
  "use strict";

  const A = window.MyaLotto;
  if (!A?.state || !A?.el?.stage) return;

  const S = A.state;
  const stage = A.el.stage;
  const frames = [...stage.querySelectorAll(".stage-transition-frame")];
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  // 모든 프레임을 먼저 로드/디코드한 뒤
  // image0 → image1 → image2 → image3 → Frame3 순서로
  // 위 레이어를 하나씩 벗겨낸다.
  const FADE_STARTS = reducedMotion
    ? [0, 55, 110, 165]
    : [0, 420, 860, 1320];
  const FADE_MS = reducedMotion ? 45 : 320;

  let opened = stage.classList.contains("mouth-open");
  let playing = false;
  let timers = [];

  function clearTimers() {
    timers.forEach((timer) => window.clearTimeout(timer));
    timers = [];
  }

  function markFailed(frame) {
    frame.dataset.loadFailed = "true";
    frame.classList.add("peeled");
  }

  async function waitUntilDecoded(frame) {
    if (!frame) return false;

    if (!frame.complete) {
      const loaded = await new Promise((resolve) => {
        const onLoad = () => resolve(true);
        const onError = () => resolve(false);
        frame.addEventListener("load", onLoad, { once: true });
        frame.addEventListener("error", onError, { once: true });
      });
      if (!loaded) {
        markFailed(frame);
        return false;
      }
    }

    if (frame.naturalWidth <= 0) {
      markFailed(frame);
      return false;
    }

    if (typeof frame.decode === "function") {
      try {
        await frame.decode();
      } catch {
        // decode() 실패라도 브라우저가 이미 표시 가능한 이미지는 그대로 사용한다.
        if (frame.naturalWidth <= 0) {
          markFailed(frame);
          return false;
        }
      }
    }

    return true;
  }

  const preloadPromise = Promise.all(frames.map(waitUntilDecoded)).then((results) => {
    results.forEach((ok, index) => {
      if (!ok) markFailed(frames[index]);
    });
    stage.classList.add("mouth-assets-ready");
    return results;
  });

  async function playOpeningSequence() {
    if (opened || playing || S.appState !== "spinning") return;

    playing = true;

    // 릴은 이미 뒤에서 돌고 있어도, 네 중간 프레임이 모두 준비될 때까지
    // 어떤 레이어도 벗기지 않는다.
    await preloadPromise;
    if (opened || S.appState !== "spinning") {
      playing = false;
      return;
    }

    stage.classList.add("mouth-transitioning");

    frames.forEach((frame, index) => {
      if (frame.dataset.loadFailed === "true") return;
      timers.push(window.setTimeout(() => {
        frame.classList.add("peeled");
      }, FADE_STARTS[index]));
    });

    const endAt = FADE_STARTS[FADE_STARTS.length - 1] + FADE_MS;
    timers.push(window.setTimeout(() => {
      opened = true;
      playing = false;
      stage.classList.remove("mouth-transitioning");
      stage.classList.add("mouth-open");
      clearTimers();
    }, endAt));
  }

  function wrapAction(owner, key) {
    const original = owner?.[key];
    if (typeof original !== "function") return;

    owner[key] = (...args) => {
      if (playing) return false;

      const previousState = S.appState;
      const result = original(...args);

      if (!opened && previousState !== "spinning" && S.appState === "spinning") {
        void playOpeningSequence();
      }

      return result;
    };
  }

  wrapAction(A.draw, "toggleDraw");
  wrapAction(A.live, "toggle");
})();
