(() => {
  "use strict";

  const A = window.MyaLotto;
  const STORAGE_KEY = "mya-lotto.ticket-output.v1";
  const REFERENCE_WIDTH = 1536;
  const REFERENCE_HEIGHT = 1024;
  const REQUIRED_MAX = 28;
  const REQUIRED_COUNT = 7;
  const TICKET_FONT_FAMILY = "MyaTicketFont";
  const TICKET_FONT_PATH = "./assets/font.ttf";
  const TICKET_MASK_PATH = "./assets/mask.png";
  const NUMBER_TEXT_BASE_DY = 5;
  const GRID_NUMBER_STYLE = { fontSize: 21.5, textDx: 0, textDy: 0.5 };
  const PURCHASE_QUANTITY = { x: 1392, y: 460, fontSize: 27 };

  const outputEnabledInput = document.getElementById("ticketOutputEnabled");
  const nicknameInput = document.getElementById("ticketNickname");
  const outputHint = document.getElementById("ticketOutputHint");
  const maxInput = document.getElementById("maxNumber");
  const countInput = document.getElementById("drawCount");

  // 실제 출력 결과의 토끼 번호 테두리를 기준으로 다시 측정한 공통 마스크 중심이다.
  // 가로 77px, 세로 67px 간격의 정규 그리드이며 mask.png의 검은 실루엣이
  // 기존 번호 테두리 안쪽에 맞도록 원본 이미지 중심보다 X를 1px 보정한다.
  const SHARED_GRID = [
    [754,527],[831,527],[908,527],[985,527],[1062,527],[1139,527],[1216,527],
    [754,594],[831,594],[908,594],[985,594],[1062,594],[1139,594],[1216,594],
    [754,661],[831,661],[908,661],[985,661],[1062,661],[1139,661],[1216,661],
    [754,728],[831,728],[908,728],[985,728],[1062,728],[1139,728],[1216,728]
  ];

  // 하단 선택 번호 7칸은 위쪽 1~7 열과 정확히 같은 X 중심을 사용한다.
  // Y만 하단 원형 칸의 실제 중심에 맞춰 별도로 유지한다.
  const SHARED_SELECTED = [
    [754,860],[831,860],[908,860],[985,860],[1062,858],[1139,860],[1216,859]
  ];

  // *2 이미지는 1~28 숫자가 인쇄되지 않은 빈 시트다.
  // 모든 색상에서 1~28, 선택 마스크의 흰 숫자, 하단 선택 번호를 같은 font.ttf로 직접 출력한다.
  const TEMPLATES = [
    {
      id: "yellow",
      label: "yellow",
      paths: ["./assets/Yellow2.png"],
      nickname: { x: 1418, y: 342, maxWidth: 126, maxHeight: 52 }
    },
    {
      id: "red",
      label: "red",
      paths: ["./assets/Red2.png"],
      nickname: { x: 1414, y: 340, maxWidth: 126, maxHeight: 52 }
    },
    {
      id: "green",
      label: "green",
      paths: ["./assets/Green2.png"],
      nickname: { x: 1406, y: 341, maxWidth: 126, maxHeight: 52 }
    },
    {
      id: "blue",
      label: "blue",
      paths: ["./assets/Blue2.png"],
      nickname: { x: 1406, y: 337, maxWidth: 126, maxHeight: 52 }
    }
  ];

  const imageCache = new Map();
  let downloadQueue = Promise.resolve();
  let compatibilityWarningKey = "";
  let missingAssetNotified = false;
  let ticketFontPromise = null;
  let ticketFontReady = false;
  let fontWarningShown = false;

  function loadSavedState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (parsed && typeof parsed.nickname === "string") nicknameInput.value = parsed.nickname;
      if (parsed && typeof parsed.enabled === "boolean") outputEnabledInput.checked = parsed.enabled;
    } catch {
      // 기본값 유지
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        nickname: nicknameInput.value,
        enabled: Boolean(outputEnabledInput.checked)
      }));
    } catch {
      // 출력 설정 저장 실패가 발급 자체를 막지는 않는다.
    }
  }

  function sanitizeFilePart(value) {
    const normalized = String(value || "익명")
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 40);
    return normalized || "익명";
  }

  function currentNickname() {
    return nicknameInput.value.trim() || "익명";
  }

  function isEnabled() {
    return Boolean(outputEnabledInput?.checked);
  }

  function isRecordCompatible(record) {
    return Boolean(
      record &&
      Number(record.max) === REQUIRED_MAX &&
      Array.isArray(record.numbers) &&
      record.numbers.length === REQUIRED_COUNT &&
      record.numbers.every((number) => Number.isInteger(number) && number >= 1 && number <= REQUIRED_MAX) &&
      new Set(record.numbers).size === REQUIRED_COUNT
    );
  }

  function refreshHint() {
    const max = Number.parseInt(maxInput.value, 10);
    const count = Number.parseInt(countInput.value, 10);
    const ready = max === REQUIRED_MAX && count === REQUIRED_COUNT;
    const enabled = isEnabled();

    if (!enabled) {
      outputHint.textContent = "체크하면 발급 완료 시 Yellow2 / Red2 / Green2 / Blue2 빈 시트 중 랜덤 1장 PNG 저장";
      outputHint.classList.remove("ready");
      return;
    }

    outputHint.textContent = ready
      ? "이미지 출력 ON · 빈 시트에 1~28과 선택 번호를 동일 폰트로 직접 출력"
      : "이미지 출력은 번호 범위 1~28 / 발급 7개 설정에서 사용";
    outputHint.classList.toggle("ready", ready);
  }

  function setDisabled(disabled) {
    const next = Boolean(disabled);
    nicknameInput.disabled = next;
    outputEnabledInput.disabled = next;
  }

  function ensureTicketFont() {
    if (ticketFontPromise) return ticketFontPromise;

    ticketFontPromise = (async () => {
      try {
        if (!("FontFace" in window) || !document.fonts) {
          throw new Error("FontFace API is not supported in this browser.");
        }

        const face = new FontFace(TICKET_FONT_FAMILY, `url("${TICKET_FONT_PATH}")`);
        const loadedFace = await face.load();
        document.fonts.add(loadedFace);
        await document.fonts.load(`16px "${TICKET_FONT_FAMILY}"`);
        ticketFontReady = true;
        return true;
      } catch (error) {
        console.error(error);
        ticketFontReady = false;
        if (!fontWarningShown) {
          fontWarningShown = true;
          A.showToast("assets/font.ttf를 불러오지 못해 기본 글꼴로 출력합니다.");
        }
        return false;
      }
    })();

    return ticketFontPromise;
  }

  function applyCanvasFont(ctx, sizePx, weight, fallbackFamily) {
    const family = ticketFontReady ? `"${TICKET_FONT_FAMILY}"` : fallbackFamily;
    ctx.font = `${weight} ${sizePx}px ${family}`;
  }

  function shuffledTemplateIndexes() {
    const indexes = TEMPLATES.map((_, index) => index);
    for (let i = indexes.length - 1; i > 0; i--) {
      const j = A.secureRandomInt(0, i);
      [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }
    return indexes;
  }

  function loadImagePath(path) {
    if (imageCache.has(path)) return imageCache.get(path);

    const promise = new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`티켓 이미지 로드 실패: ${path}`));
      image.src = path;
    });
    imageCache.set(path, promise);
    return promise;
  }

  async function loadTemplate(template) {
    let lastError = null;
    for (const path of template.paths) {
      try {
        const image = await loadImagePath(path);
        return { image, path };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`티켓 이미지가 없습니다: ${template.id}`);
  }

  async function pickRandomAvailableTemplate() {
    const indexes = shuffledTemplateIndexes();
    let lastError = null;
    for (const index of indexes) {
      const template = TEMPLATES[index];
      try {
        const loaded = await loadTemplate(template);
        return { template, ...loaded };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("사용 가능한 티켓 이미지가 없습니다.");
  }

  function drawFittedText(ctx, text, box, sx, sy) {
    const x = box.x * sx;
    const y = box.y * sy;
    const maxWidth = box.maxWidth * sx;
    const maxHeight = box.maxHeight * sy;
    let fontSize = Math.min(31 * sy, maxHeight * 0.68);

    ctx.save();
    ctx.fillStyle = "#070707";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyCanvasFont(ctx, fontSize, 800, 'Pretendard, "Noto Sans KR", system-ui, sans-serif');
    while (fontSize > 14 * sy && ctx.measureText(text).width > maxWidth) {
      fontSize -= 1 * sy;
      applyCanvasFont(ctx, fontSize, 800, 'Pretendard, "Noto Sans KR", system-ui, sans-serif');
    }
    ctx.fillText(text, x, y, maxWidth);
    ctx.restore();
  }

  function applyGridNumberFont(ctx, sy) {
    applyCanvasFont(
      ctx,
      Math.max(14, GRID_NUMBER_STYLE.fontSize * sy),
      900,
      "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    );
  }

  function drawGridNumbers(ctx, sx, sy) {
    ctx.save();
    ctx.fillStyle = "#080808";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyGridNumberFont(ctx, sy);

    SHARED_GRID.forEach((center, index) => {
      ctx.fillText(
        String(index + 1),
        center[0] * sx + GRID_NUMBER_STYLE.textDx * sx,
        center[1] * sy + (NUMBER_TEXT_BASE_DY + GRID_NUMBER_STYLE.textDy) * sy
      );
    });
    ctx.restore();
  }

  function drawSelectedGridMark(ctx, center, number, maskImage, sx, sy) {
    const x = center[0] * sx;
    const y = center[1] * sy;
    const maskWidth = (maskImage.naturalWidth || maskImage.width) * sx;
    const maskHeight = (maskImage.naturalHeight || maskImage.height) * sy;

    ctx.save();
    ctx.drawImage(
      maskImage,
      x - maskWidth / 2,
      y - maskHeight / 2,
      maskWidth,
      maskHeight
    );

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyGridNumberFont(ctx, sy);
    ctx.fillText(
      String(number),
      x + GRID_NUMBER_STYLE.textDx * sx,
      y + (NUMBER_TEXT_BASE_DY + GRID_NUMBER_STYLE.textDy) * sy
    );
    ctx.restore();
  }

  function drawSelectedRow(ctx, numbers, sx, sy) {
    ctx.save();
    ctx.fillStyle = "#080808";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyCanvasFont(ctx, Math.max(16, 27 * sy), 900, "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
    [...numbers].sort((a, b) => a - b).forEach((number, index) => {
      const center = SHARED_SELECTED[index];
      if (!center) return;
      ctx.fillText(String(number), center[0] * sx, center[1] * sy);
    });
    ctx.restore();
  }

  function drawPurchaseQuantity(ctx, sx, sy) {
    ctx.save();
    ctx.fillStyle = "#080808";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyCanvasFont(
      ctx,
      Math.max(16, PURCHASE_QUANTITY.fontSize * sy),
      900,
      "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    );
    ctx.fillText("1", PURCHASE_QUANTITY.x * sx, PURCHASE_QUANTITY.y * sy);
    ctx.restore();
  }

  function renderTicket(image, template, maskImage, record, nickname) {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const sx = canvas.width / REFERENCE_WIDTH;
    const sy = canvas.height / REFERENCE_HEIGHT;

    drawFittedText(ctx, nickname, template.nickname, sx, sy);
    drawPurchaseQuantity(ctx, sx, sy);
    drawGridNumbers(ctx, sx, sy);

    record.numbers.forEach((number) => {
      const center = SHARED_GRID[number - 1];
      if (center) drawSelectedGridMark(ctx, center, number, maskImage, sx, sy);
    });
    drawSelectedRow(ctx, record.numbers, sx, sy);
    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG 생성에 실패했습니다."));
      }, "image/png");
    });
  }

  async function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function issueTicket(job) {
    if (!job?.enabled) return null;
    const record = job.record;

    if (!isRecordCompatible(record)) {
      const key = `${record?.max}:${record?.numbers?.length}`;
      if (compatibilityWarningKey !== key) {
        compatibilityWarningKey = key;
        A.showToast("티켓 PNG는 번호 범위 1~28, 발급 7개 설정에서 출력됩니다.");
      }
      return null;
    }

    const nickname = job.nickname || "익명";
    try {
      await ensureTicketFont();
      const [{ template, image }, maskImage] = await Promise.all([
        pickRandomAvailableTemplate(),
        loadImagePath(TICKET_MASK_PATH)
      ]);
      const canvas = renderTicket(image, template, maskImage, record, nickname);
      const blob = await canvasToBlob(canvas);
      const numbers = record.numbers.map((number) => String(number).padStart(2, "0")).join("-");
      const filename = `MYA_LOTTO_${sanitizeFilePart(nickname)}_${template.label}_${numbers}.png`;
      await downloadBlob(blob, filename);
      missingAssetNotified = false;
      return template.id;
    } catch (error) {
      console.error(error);
      if (!missingAssetNotified) {
        missingAssetNotified = true;
        A.showToast("티켓 이미지 또는 assets/mask.png를 찾지 못했습니다. assets/Yellow2.png, Red2.png, Green2.png, Blue2.png 파일을 확인하세요.");
      }
      return null;
    }
  }

  function makeJob(record, enabled, nickname) {
    return {
      enabled,
      nickname,
      record: {
        max: Number(record?.max),
        numbers: Array.isArray(record?.numbers) ? record.numbers.slice() : []
      }
    };
  }

  function enqueue(record) {
    const job = makeJob(record, isEnabled(), currentNickname());
    if (!job.enabled) return Promise.resolve(null);

    const task = downloadQueue.then(() => issueTicket(job));
    downloadQueue = task.catch((error) => {
      console.error(error);
      return null;
    });
    return task;
  }

  function enqueueMany(records) {
    const enabled = isEnabled();
    const nickname = currentNickname();
    const jobs = Array.isArray(records)
      ? records.map((record) => makeJob(record, enabled, nickname))
      : [];

    if (!enabled || !jobs.length) return Promise.resolve([]);

    const task = downloadQueue.then(async () => {
      const results = [];
      for (const job of jobs) {
        results.push(await issueTicket(job));
      }
      return results;
    });

    downloadQueue = task.then(() => null).catch((error) => {
      console.error(error);
      return null;
    });
    return task;
  }

  nicknameInput.addEventListener("input", saveState);
  outputEnabledInput.addEventListener("change", () => {
    saveState();
    refreshHint();
  });
  maxInput.addEventListener("change", refreshHint);
  countInput.addEventListener("change", refreshHint);
  loadSavedState();
  refreshHint();

  A.ticket = {
    enqueue,
    enqueueMany,
    setDisabled,
    refreshHint,
    isEnabled,
    templates: TEMPLATES.map(({ id, label, paths }) => ({ id, label, paths: paths.slice() }))
  };
})();