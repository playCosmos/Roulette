(() => {
  "use strict";

  const A = window.MyaLotto;
  if (!A?.state || !A?.el?.stage) return;

  const S = A.state;
  const stage = A.el.stage;
  const frames = [...stage.querySelectorAll(".stage-transition-frame")];
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  // 모든 프레임을 먼저 로드/디코드한 뒤
  // image0 → image1 → image2 → image3 → Frame3 순서로 위 레이어를 벗긴다.
  // 페이드 시간은 400ms에서 시작하고 감소폭은 20ms → 40ms → 80ms.
  // 다음 프레임 페이드는 이전 프레임의 실제 opacity가 약 0.2가 되는 순간 시작한다.
  const FADE_DURATIONS = reducedMotion
    ? [45, 45, 45, 45]
    : [400, 380, 340, 260];
  const NEXT_FADE_OPACITY = 0.2;

  let opened = stage.classList.contains("mouth-open");
  let playing = false;

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

  frames.forEach((frame, index) => {
    frame.style.setProperty("--mouth-fade-ms", `${FADE_DURATIONS[index] || FADE_DURATIONS[0]}ms`);
  });

  const preloadPromise = Promise.all(frames.map(waitUntilDecoded)).then((results) => {
    results.forEach((ok, index) => {
      if (!ok) markFailed(frames[index]);
    });
    return results;
  });

  function waitForOpacity(frame, targetOpacity, fallbackMs) {
    return new Promise((resolve) => {
      const startedAt = performance.now();

      const check = () => {
        if (!playing || frame.dataset.loadFailed === "true") {
          resolve();
          return;
        }

        const opacity = Number.parseFloat(getComputedStyle(frame).opacity);
        if (Number.isFinite(opacity) && opacity <= targetOpacity + 0.015) {
          resolve();
          return;
        }

        if (performance.now() - startedAt >= fallbackMs) {
          resolve();
          return;
        }

        window.requestAnimationFrame(check);
      };

      window.requestAnimationFrame(check);
    });
  }

  function waitForFadeEnd(frame, fallbackMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        frame.removeEventListener("transitionend", onEnd);
        resolve();
      };
      const onEnd = (event) => {
        if (event.propertyName === "opacity") finish();
      };

      frame.addEventListener("transitionend", onEnd);
      window.setTimeout(finish, fallbackMs + 80);
    });
  }

  async function playOpeningSequence() {
    if (opened || playing || S.appState !== "spinning") return;

    playing = true;

    // 릴은 뒤에서 먼저 돌 수 있지만 네 중간 프레임이 모두 준비될 때까지
    // 어떤 레이어도 벗기지 않는다.
    await preloadPromise;
    if (opened || S.appState !== "spinning") {
      playing = false;
      return;
    }

    stage.classList.add("mouth-transitioning");

    const usableFrames = frames.filter((frame) => frame.dataset.loadFailed !== "true");
    for (let index = 0; index < usableFrames.length; index++) {
      const frame = usableFrames[index];
      const sourceIndex = frames.indexOf(frame);
      const fadeMs = FADE_DURATIONS[sourceIndex] || FADE_DURATIONS[0];

      frame.classList.add("peeled");

      if (index < usableFrames.length - 1) {
        // 실제 렌더링된 opacity가 약 0.2까지 내려온 순간 다음 레이어 페이드를 시작한다.
        await waitForOpacity(frame, NEXT_FADE_OPACITY, fadeMs);
      } else {
        await waitForFadeEnd(frame, fadeMs);
      }
    }

    opened = true;
    playing = false;
    stage.classList.remove("mouth-transitioning");
    stage.classList.add("mouth-open");
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