(() => {
  "use strict";

  const NUMBER_MAX = 28;
  const NUMBER_COUNT = 7;
  const SPIN_LEAD_MS = 1350;
  const STOP_INTERVAL_MS = 360;
  const STOP_SETTLE_MS = 700;
  const TICKET_HOLD_MS = 5200;
  const BETWEEN_JOBS_MS = 420;

  const REFERENCE_WIDTH = 1536;
  const REFERENCE_HEIGHT = 1024;
  const FONT_FAMILY = "MyaTicketFont";
  const FONT_PATH = "./assets/font.ttf";
  const MASK_PATH = "./assets/mask.png";
  const GRID_FONT_SIZE = 21.5;
  const NUMBER_TEXT_BASE_DY = 5;
  const PURCHASE_QUANTITY = { x: 1392, y: 460, fontSize: 27 };

  const GRID = [
    [754,527],[831,527],[908,527],[985,527],[1062,527],[1139,527],[1216,527],
    [754,594],[831,594],[908,594],[985,594],[1062,594],[1139,594],[1216,594],
    [754,661],[831,661],[908,661],[985,661],[1062,661],[1139,661],[1216,661],
    [754,728],[831,728],[908,728],[985,728],[1062,728],[1139,728],[1216,728]
  ];

  const SELECTED = [
    [754,860],[831,860],[908,860],[985,860],[1062,858],[1139,860],[1216,859]
  ];

  const TEMPLATES = [
    { id: "yellow", path: "./assets/Yellow2.png", nickname: { x: 1418, y: 342, maxWidth: 126, maxHeight: 52 } },
    { id: "red", path: "./assets/Red2.png", nickname: { x: 1414, y: 340, maxWidth: 126, maxHeight: 52 } },
    { id: "green", path: "./assets/Green2.png", nickname: { x: 1406, y: 341, maxWidth: 126, maxHeight: 52 } },
    { id: "blue", path: "./assets/Blue2.png", nickname: { x: 1406, y: 337, maxWidth: 126, maxHeight: 52 } }
  ];

  const el = {
    rouletteScene: document.getElementById("rouletteScene"),
    ticketScene: document.getElementById("ticketScene"),
    donorName: document.getElementById("donorName"),
    characterStage: document.getElementById("characterStage"),
    progress: document.getElementById("rouletteProgress"),
    reels: [...document.querySelectorAll(".reel")],
    ticketOwner: document.getElementById("ticketOwner"),
    ticketPreview: document.getElementById("ticketPreview"),
    ticketNumbers: document.getElementById("ticketNumbers"),
    ticketId: document.getElementById("ticketId"),
    debugPanel: document.getElementById("debugPanel"),
    testIssueButton: document.getElementById("testIssueButton"),
    debugStatus: document.getElementById("debugStatus")
  };

  const imageCache = new Map();
  const queue = [];
  let processing = false;
  let fontReady = false;
  let fontPromise = null;
  let websocket = null;

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function secureRandomInt(min, max) {
    const range = max - min + 1;
    if (range <= 0) throw new RangeError("Invalid random range");
    const maxUint = 0x100000000;
    const limit = maxUint - (maxUint % range);
    const buffer = new Uint32Array(1);
    let value;
    do {
      crypto.getRandomValues(buffer);
      value = buffer[0];
    } while (value >= limit);
    return min + (value % range);
  }

  function generateUniqueNumbers() {
    const pool = Array.from({ length: NUMBER_MAX }, (_, index) => index + 1);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = secureRandomInt(0, i);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, NUMBER_COUNT);
  }

  function isValidNumbers(numbers) {
    return Array.isArray(numbers) &&
      numbers.length === NUMBER_COUNT &&
      numbers.every((value) => Number.isInteger(value) && value >= 1 && value <= NUMBER_MAX) &&
      new Set(numbers).size === NUMBER_COUNT;
  }

  function normalizeTicket(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("ticket payload is required");
    }

    const numbers = Array.isArray(input.numbers)
      ? input.numbers.map((value) => Number(value))
      : [];

    if (!isValidNumbers(numbers)) {
      throw new Error("ticket.numbers must contain 7 unique integers from 1 to 28");
    }

    const nickname = String(input.nickname || "익명").trim().slice(0, 40) || "익명";
    const ticketId = String(input.ticketId || `T-${Date.now()}`);

    return {
      type: "ticket.issue",
      ticketId,
      donorId: input.donorId == null ? null : String(input.donorId),
      nickname,
      numbers: numbers.slice(),
      totalBalloons: Number.isFinite(Number(input.totalBalloons)) ? Number(input.totalBalloons) : null,
      ticketNumber: Number.isFinite(Number(input.ticketNumber)) ? Number(input.ticketNumber) : null,
      issuedAt: input.issuedAt ? String(input.issuedAt) : new Date().toISOString()
    };
  }

  function formatNumber(value) {
    return String(value).padStart(2, "0");
  }

  function setScene(scene) {
    const rouletteVisible = scene === "roulette";
    const ticketVisible = scene === "ticket";

    el.rouletteScene.classList.toggle("is-visible", rouletteVisible);
    el.ticketScene.classList.toggle("is-visible", ticketVisible);
    el.rouletteScene.setAttribute("aria-hidden", String(!rouletteVisible));
    el.ticketScene.setAttribute("aria-hidden", String(!ticketVisible));
  }

  function resetReels() {
    el.characterStage.classList.remove("is-complete");
    el.reels.forEach((reel, index) => {
      reel.classList.remove("is-spinning", "is-stopped");
      const span = reel.querySelector("span");
      if (span) span.textContent = formatNumber(index + 1);
    });
  }

  async function animateRoulette(ticket) {
    resetReels();
    el.donorName.textContent = ticket.nickname;
    el.progress.textContent = "티켓 번호 추첨 중";
    setScene("roulette");

    const timers = el.reels.map((reel) => {
      reel.classList.add("is-spinning");
      const span = reel.querySelector("span");
      return window.setInterval(() => {
        if (span) span.textContent = formatNumber(secureRandomInt(1, NUMBER_MAX));
      }, 52 + secureRandomInt(0, 25));
    });

    await sleep(SPIN_LEAD_MS);

    for (let index = 0; index < NUMBER_COUNT; index++) {
      window.clearInterval(timers[index]);
      const reel = el.reels[index];
      const span = reel.querySelector("span");
      reel.classList.remove("is-spinning");
      reel.classList.add("is-stopped");
      if (span) span.textContent = formatNumber(ticket.numbers[index]);
      el.progress.textContent = `${index + 1} / ${NUMBER_COUNT} 번호 확정`;
      await sleep(STOP_INTERVAL_MS);
    }

    el.characterStage.classList.add("is-complete");
    el.progress.textContent = "번호 확정 · 티켓 발급 중";
    await sleep(STOP_SETTLE_MS);
  }

  function loadImage(path) {
    if (imageCache.has(path)) return imageCache.get(path);

    const promise = new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`이미지 로드 실패: ${path}`));
      image.src = path;
    });
    imageCache.set(path, promise);
    return promise;
  }

  function ensureFont() {
    if (fontPromise) return fontPromise;

    fontPromise = (async () => {
      try {
        if (!("FontFace" in window) || !document.fonts) return false;
        const face = new FontFace(FONT_FAMILY, `url("${FONT_PATH}")`);
        const loaded = await face.load();
        document.fonts.add(loaded);
        await document.fonts.load(`16px "${FONT_FAMILY}"`);
        fontReady = true;
        return true;
      } catch (error) {
        console.warn("티켓 폰트 로드 실패. 시스템 폰트를 사용합니다.", error);
        fontReady = false;
        return false;
      }
    })();

    return fontPromise;
  }

  function applyFont(ctx, sizePx, weight, fallback) {
    const family = fontReady ? `"${FONT_FAMILY}"` : fallback;
    ctx.font = `${weight} ${sizePx}px ${family}`;
  }

  function drawNickname(ctx, nickname, box, sx, sy) {
    const x = box.x * sx;
    const y = box.y * sy;
    const maxWidth = box.maxWidth * sx;
    const maxHeight = box.maxHeight * sy;
    let fontSize = Math.min(31 * sy, maxHeight * .68);

    ctx.save();
    ctx.fillStyle = "#070707";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyFont(ctx, fontSize, 800, 'Pretendard, "Noto Sans KR", system-ui, sans-serif');
    while (fontSize > 14 * sy && ctx.measureText(nickname).width > maxWidth) {
      fontSize -= 1 * sy;
      applyFont(ctx, fontSize, 800, 'Pretendard, "Noto Sans KR", system-ui, sans-serif');
    }
    ctx.fillText(nickname, x, y, maxWidth);
    ctx.restore();
  }

  function applyGridFont(ctx, sy) {
    applyFont(ctx, Math.max(14, GRID_FONT_SIZE * sy), 900, "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
  }

  function drawGrid(ctx, sx, sy) {
    ctx.save();
    ctx.fillStyle = "#080808";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyGridFont(ctx, sy);
    GRID.forEach((center, index) => {
      ctx.fillText(String(index + 1), center[0] * sx, center[1] * sy + NUMBER_TEXT_BASE_DY * sy);
    });
    ctx.restore();
  }

  function drawSelectedMark(ctx, center, number, maskImage, sx, sy) {
    const x = center[0] * sx;
    const y = center[1] * sy;
    const width = (maskImage.naturalWidth || maskImage.width) * sx;
    const height = (maskImage.naturalHeight || maskImage.height) * sy;

    ctx.save();
    ctx.drawImage(maskImage, x - width / 2, y - height / 2, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyGridFont(ctx, sy);
    ctx.fillText(String(number), x, y + NUMBER_TEXT_BASE_DY * sy);
    ctx.restore();
  }

  function drawSelectedRow(ctx, numbers, sx, sy) {
    ctx.save();
    ctx.fillStyle = "#080808";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyFont(ctx, Math.max(16, 27 * sy), 900, "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
    [...numbers].sort((a, b) => a - b).forEach((number, index) => {
      const center = SELECTED[index];
      if (center) ctx.fillText(String(number), center[0] * sx, center[1] * sy);
    });
    ctx.restore();
  }

  function drawPurchaseQuantity(ctx, sx, sy) {
    ctx.save();
    ctx.fillStyle = "#080808";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyFont(ctx, Math.max(16, PURCHASE_QUANTITY.fontSize * sy), 900, "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
    ctx.fillText("1", PURCHASE_QUANTITY.x * sx, PURCHASE_QUANTITY.y * sy);
    ctx.restore();
  }

  async function renderTicket(ticket) {
    await ensureFont();

    const template = TEMPLATES[secureRandomInt(0, TEMPLATES.length - 1)];
    const [image, maskImage] = await Promise.all([
      loadImage(template.path),
      loadImage(MASK_PATH)
    ]);

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context를 만들 수 없습니다.");

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const sx = canvas.width / REFERENCE_WIDTH;
    const sy = canvas.height / REFERENCE_HEIGHT;

    drawNickname(ctx, ticket.nickname, template.nickname, sx, sy);
    drawPurchaseQuantity(ctx, sx, sy);
    drawGrid(ctx, sx, sy);

    ticket.numbers.forEach((number) => {
      const center = GRID[number - 1];
      if (center) drawSelectedMark(ctx, center, number, maskImage, sx, sy);
    });
    drawSelectedRow(ctx, ticket.numbers, sx, sy);

    return canvas.toDataURL("image/png");
  }

  function renderNumberBadges(numbers) {
    el.ticketNumbers.replaceChildren(...numbers.map((number) => {
      const span = document.createElement("span");
      span.textContent = formatNumber(number);
      return span;
    }));
  }

  async function showTicket(ticket) {
    el.ticketOwner.textContent = ticket.nickname;
    el.ticketId.textContent = ticket.ticketId;
    renderNumberBadges(ticket.numbers);

    try {
      el.ticketPreview.src = await renderTicket(ticket);
    } catch (error) {
      console.error(error);
      el.ticketPreview.removeAttribute("src");
    }

    setScene("ticket");
    await sleep(TICKET_HOLD_MS);
    setScene("none");
    await sleep(BETWEEN_JOBS_MS);
  }

  async function processQueue() {
    if (processing) return;
    processing = true;

    try {
      while (queue.length) {
        const ticket = queue.shift();
        updateDebugStatus(`처리 중 · ${ticket.nickname} · ${ticket.ticketId}`);
        await animateRoulette(ticket);
        await showTicket(ticket);
        updateDebugStatus(`완료 · ${ticket.ticketId}`);
        window.dispatchEvent(new CustomEvent("roulette-overlay:completed", { detail: ticket }));
      }
    } finally {
      processing = false;
      if (!queue.length) updateDebugStatus("대기 중");
    }
  }

  function enqueueTicket(payload) {
    const ticket = normalizeTicket(payload);
    queue.push(ticket);
    updateDebugStatus(`대기열 ${queue.length}건`);
    processQueue().catch((error) => {
      console.error(error);
      updateDebugStatus(`오류 · ${error.message}`);
      processing = false;
    });
    return ticket.ticketId;
  }

  function updateDebugStatus(message) {
    if (el.debugStatus) el.debugStatus.textContent = message;
  }

  function handleBridgeMessage(raw) {
    let payload = raw;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw);
      } catch {
        return false;
      }
    }

    if (!payload || typeof payload !== "object") return false;
    if (!["ticket.issue", "ticket.issued", "roulette.ticket.issue"].includes(payload.type)) return false;

    try {
      enqueueTicket(payload);
      return true;
    } catch (error) {
      console.error("티켓 이벤트 거부", error, payload);
      updateDebugStatus(`이벤트 오류 · ${error.message}`);
      return false;
    }
  }

  function connect(url) {
    if (!url) throw new Error("WebSocket URL is required");
    if (websocket) websocket.close();

    websocket = new WebSocket(url);
    websocket.addEventListener("open", () => updateDebugStatus("브리지 연결됨"));
    websocket.addEventListener("message", (event) => handleBridgeMessage(event.data));
    websocket.addEventListener("close", () => updateDebugStatus("브리지 연결 종료"));
    websocket.addEventListener("error", () => updateDebugStatus("브리지 연결 오류"));
    return websocket;
  }

  function createDebugTicket() {
    return {
      type: "ticket.issue",
      ticketId: `TEST-${Date.now()}`,
      donorId: "debug-user",
      nickname: "테스트후원자",
      totalBalloons: 150,
      ticketNumber: 3,
      numbers: generateUniqueNumbers()
    };
  }

  function initDebugMode() {
    const params = new URLSearchParams(location.search);
    const debug = params.get("debug") === "1";
    const autoTest = params.get("autotest") === "1";
    const wsUrl = params.get("ws");

    if (debug) {
      el.debugPanel.hidden = false;
      el.testIssueButton?.addEventListener("click", () => enqueueTicket(createDebugTicket()));
    }

    if (wsUrl) {
      try {
        connect(wsUrl);
      } catch (error) {
        console.error(error);
        updateDebugStatus(`연결 실패 · ${error.message}`);
      }
    }

    if (autoTest) {
      window.setTimeout(() => enqueueTicket(createDebugTicket()), 700);
    }
  }

  window.addEventListener("message", (event) => {
    handleBridgeMessage(event.data);
  });

  window.RouletteOverlay = Object.freeze({
    enqueueTicket,
    connect,
    handleBridgeMessage,
    createDebugTicket,
    version: "1.0.0"
  });

  setScene("none");
  initDebugMode();
})();
