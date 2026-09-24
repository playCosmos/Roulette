(() => {
  "use strict";

  const DEFAULT_REVEAL_MS = 1050;
  const DEFAULT_HOLD_MS = 1100;
  const DICE_PIP_POSITIONS = {
    1: ["c"],
    2: ["tl", "br"],
    3: ["tl", "c", "br"],
    4: ["tl", "tr", "bl", "br"],
    5: ["tl", "tr", "c", "bl", "br"],
    6: ["tl", "ml", "bl", "tr", "mr", "br"]
  };

  let refs = null;
  let activeRun = 0;
  let rollerTimer = 0;
  let hideTimer = 0;

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function ensureRefs() {
    if (refs) return refs;
    refs = {
      root: document.getElementById("throwPresentation"),
      stage: document.getElementById("throwPresentationStage"),
      label: document.getElementById("throwPresentationLabel"),
      result: document.getElementById("throwPresentationResult")
    };
    return refs;
  }

  function clearTimers() {
    if (rollerTimer) {
      window.clearInterval(rollerTimer);
      rollerTimer = 0;
    }
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }

  function createDie(value) {
    const die = document.createElement("div");
    die.className = "throw-die";
    die.dataset.value = String(value);

    for (const position of DICE_PIP_POSITIONS[value] || []) {
      const pip = document.createElement("span");
      pip.className = "throw-die-pip";
      pip.dataset.position = position;
      die.append(pip);
    }
    return die;
  }

  function renderDice(values) {
    const { stage } = ensureRefs();
    stage.innerHTML = "";
    stage.dataset.generator = "dice";
    for (const value of values) {
      stage.append(createDie(value));
    }
  }

  function yutFacesFor(name) {
    const special = 0;
    const convex = { face: "convex", special: false };
    const flat = (isSpecial = false) => ({ face: "flat", special: isSpecial });

    switch (String(name || "").toUpperCase()) {
      case "BACK_DO":
        return [flat(true), convex, convex, convex];
      case "DO":
        return [
          { face: "convex", special: true },
          flat(false),
          convex,
          convex
        ];
      case "GAE":
        return [
          { face: "convex", special: true },
          flat(false),
          flat(false),
          convex
        ];
      case "GEOL":
        return [
          { face: "convex", special: true },
          flat(false),
          flat(false),
          flat(false)
        ];
      case "YUT":
        return [flat(true), flat(false), flat(false), flat(false)];
      case "MO":
      default:
        return [
          { face: "convex", special: true },
          convex,
          convex,
          convex
        ];
    }
  }

  function createYutPiece(face, index) {
    const piece = document.createElement("div");
    piece.className = "throw-yut-piece";
    piece.dataset.face = face.face;
    piece.dataset.special = String(Boolean(face.special));
    piece.dataset.index = String(index);

    const body = document.createElement("div");
    body.className = "throw-yut-body";

    const marker = document.createElement("span");
    marker.className = "throw-yut-marker";
    marker.setAttribute("aria-hidden", "true");

    body.append(marker);
    piece.append(body);
    return piece;
  }

  function renderYut(name) {
    const { stage } = ensureRefs();
    stage.innerHTML = "";
    stage.dataset.generator = "yut";
    yutFacesFor(name).forEach((face, index) => {
      stage.append(createYutPiece(face, index));
    });
  }

  function yutLabel(name) {
    switch (String(name || "").toUpperCase()) {
      case "BACK_DO": return "뒷도";
      case "DO": return "도";
      case "GAE": return "개";
      case "GEOL": return "걸";
      case "YUT": return "윷";
      case "MO": return "모";
      default: return "윷";
    }
  }

  function resultText(event) {
    if (event.generator === "dice") {
      const values = event.dice?.values || [];
      const total = Number(event.dice?.total) ||
        values.reduce((sum, value) => sum + Number(value || 0), 0);
      const suffix = event.bonusThrow ? " · 더블! 한 번 더" : "";
      return values.join(" + ") + " = " + total + suffix;
    }

    const name = event.yut?.name || "DO";
    const steps = Number(event.yut?.steps) || 0;
    const direction = steps < 0 ? steps + "칸" : "+" + steps + "칸";
    const suffix = event.bonusThrow ? " · 한 번 더" : "";
    return yutLabel(name) + " · " + direction + suffix;
  }

  function setFinalVisual(event) {
    if (event.generator === "dice") {
      renderDice(event.dice?.values || [1]);
    } else {
      renderYut(event.yut?.name || "DO");
    }
  }

  function setRollingVisual(event) {
    if (event.generator === "dice") {
      const count = Math.max(1, Math.min(2, event.dice?.values?.length || 1));
      renderDice(Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6)));
      rollerTimer = window.setInterval(() => {
        renderDice(Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6)));
      }, 90);
      return;
    }

    const names = ["BACK_DO", "DO", "GAE", "GEOL", "YUT", "MO"];
    renderYut(names[Math.floor(Math.random() * names.length)]);
    rollerTimer = window.setInterval(() => {
      renderYut(names[Math.floor(Math.random() * names.length)]);
    }, 105);
  }

  function hide(runId) {
    const { root, stage, result, label } = ensureRefs();
    if (!root || runId !== activeRun) return;
    root.dataset.visible = "false";
    root.dataset.phase = "idle";
    stage.innerHTML = "";
    result.textContent = "";
    label.textContent = "";
  }

  function present(event, player, options = {}) {
    const { root, label, result } = ensureRefs();
    if (!root) {
      const instant = Promise.resolve();
      return { reveal: instant, finished: instant };
    }

    clearTimers();
    const runId = ++activeRun;
    const revealMs = Math.max(0, Number(options.revealMs) || DEFAULT_REVEAL_MS);
    const holdMs = Math.max(0, Number(options.holdMs) || DEFAULT_HOLD_MS);

    root.dataset.visible = "true";
    root.dataset.phase = "rolling";
    root.dataset.generator = event.generator;
    label.textContent = player?.name ? player.name + " · 던지는 중" : "던지는 중";
    result.textContent = "";
    setRollingVisual(event);

    const reveal = delay(revealMs).then(() => {
      if (runId !== activeRun) return;
      if (rollerTimer) {
        window.clearInterval(rollerTimer);
        rollerTimer = 0;
      }
      setFinalVisual(event);
      root.dataset.phase = "revealed";
      label.textContent = player?.name || "";
      result.textContent = resultText(event);
      window.dispatchEvent(new CustomEvent("ramyani-throw:revealed", {
        detail: { event, playerId: player?.id || event.playerId || null }
      }));
    });

    const finished = reveal.then(() => delay(holdMs)).then(() => {
      if (runId !== activeRun) return;
      hide(runId);
    });

    return { reveal, finished };
  }

  function getBubbleData(event) {
    if (event.generator === "dice") {
      const values = (event.dice?.values || []).slice(0, 2);
      return {
        generator: "dice",
        values,
        text: String(event.dice?.total ?? values.reduce((a, b) => a + b, 0)),
        bonus: Boolean(event.bonusThrow)
      };
    }

    return {
      generator: "yut",
      name: String(event.yut?.name || "DO").toUpperCase(),
      faces: yutFacesFor(event.yut?.name || "DO"),
      text: yutLabel(event.yut?.name || "DO") + " " +
        ((Number(event.yut?.steps) || 0) >= 0 ? "+" : "") +
        String(Number(event.yut?.steps) || 0),
      bonus: Boolean(event.bonusThrow)
    };
  }

  window.RamyaniThrowPresentation = Object.freeze({
    present,
    getBubbleData,
    yutFacesFor
  });
})();
