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

  const outputEnabledInput = document.getElementById("ticketOutputEnabled");
  const nicknameInput = document.getElementById("ticketNickname");
  const outputHint = document.getElementById("ticketOutputHint");
  const maxInput = document.getElementById("maxNumber");
  const countInput = document.getElementById("drawCount");

  // Yellow3 / Red3 / Green3 / Blue3는 1~28 번호와 하단 선택 번호 위치를
  // 동일하게 맞춘 시트다. 한 좌표 테이블만 사용해 모든 색상에 똑같이 적용한다.
  const SHARED_GRID = [
    [747,531],[829,539],[909,539],[992,532],[1069,535],[1150,532],[1227,543],
    [747,601],[831,599],[909,597],[991,601],[1067,601],[1150,599],[1231,599],
    [747,665],[829,673],[907,667],[991,667],[1070,665],[1150,667],[1229,667],
    [752,733],[831,733],[907,731],[991,733],[1069,734],[1145,733],[1227,731]
  ];

  const SHARED_SELECTED = [
    [752,869],[832,871],[922,871],[1010,871],[1088,865],[1178,871],[1258,869]
  ];

  // 위치는 공통으로 사용하되 색상별 인쇄 틀의 미세한 모양 차이는 mark 프로파일로 유지한다.
  const TEMPLATES = [
    {
      id: "yellow",
      label: "yellow",
      paths: ["./assets/Yellow3.png"],
      nickname: { x: 1418, y: 342, maxWidth: 126, maxHeight: 52 },
      mark: { rx: 25.5, ry: 22.8, exponent: 2.55, samples: 72, fontSize: 21.5, textDx: 0, textDy: 0.5 }
    },
    {
      id: "red",
      label: "red",
      paths: ["./assets/Red3.png"],
      nickname: { x: 1414, y: 340, maxWidth: 126, maxHeight: 52 },
      mark: { rx: 25.3, ry: 22.4, exponent: 2.70, samples: 72, fontSize: 21.5, textDx: 0, textDy: 0.5 }
    },
    {
      id: "green",
      label: "green",
      paths: ["./assets/Green3.png"],
      nickname: { x: 1406, y: 341, maxWidth: 126, maxHeight: 52 },
      mark: { rx: 24.9, ry: 22.6, exponent: 2.40, samples: 72, fontSize: 21.0, textDx: 0, textDy: 0.3 }
    },
    {
      id: "blue",
      label: "blue",
      paths: ["./assets/Blue3.png"],
      nickname: { x: 1406, y: 337, maxWidth: 126, maxHeight: 52 },
      mark: { rx: 25.0, ry: 22.3, exponent: 2.65, samples: 72, fontSize: 21.0, textDx: 0, textDy: 0.4 }
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
      outputHint.textContent = "체크하면 발급 완료 시 Yellow3 / Red3 / Green3 / Blue3 중 랜덤 1장 PNG 저장";
      outputHint.classList.remove("ready");
      return;
    }

    outputHint.textContent = ready
      ? "이미지 출력 ON · 4개 시트 공통 번호 좌표를 직접 채움"
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

  function superellipseRadius(rx, ry, exponent, angle) {
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const n = Math.max(1.5, exponent || 2);
    const denominator = Math.pow(
      Math.pow(cos / Math.max(1, rx), n) + Math.pow(sin / Math.max(1, ry), n),
      1 / n
    );
    return denominator > 0 ? 1 / denominator : Math.min(rx, ry);
  }

  function buildFixedMarkPath(ctx, center, profile, sx, sy) {
    const cx = center[0] * sx;
    const cy = center[1] * sy;
    const rx = profile.rx * sx;
    const ry = profile.ry * sy;
    const samples = Math.max(40, profile.samples || 64);

    ctx.beginPath();
    for (let index = 0; index < samples; index++) {
      const angle = (index / samples) * Math.PI * 2;
      const radius = superellipseRadius(rx, ry, profile.exponent, angle);
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
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

  function drawSelectedGridMark(ctx, center, number, template, sx, sy) {
    const profile = template.mark;
    const x = center[0] * sx;
    const y = center[1] * sy;

    ctx.save();
    buildFixedMarkPath(ctx, center, profile, sx, sy);
    ctx.fillStyle = "rgba(0, 0, 0, .975)";
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyCanvasFont(
      ctx,
      Math.max(14, profile.fontSize * sy),
      900,
      "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    );
    ctx.fillText(
      String(number),
      x + (profile.textDx || 0) * sx,
      y + (profile.textDy || 0) * sy
    );
    ctx.restore();
  }

  function drawSelectedRow(ctx, numbers, sx, sy) {
    ctx.save();
    ctx.fillStyle = "#080808";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyCanvasFont(ctx, Math.max(16, 27 * sy), 900, "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
    numbers.forEach((number, index) => {
      const center = SHARED_SELECTED[index];
      if (!center) return;
      ctx.fillText(String(number), center[0] * sx, center[1] * sy + 1 * sy);
    });
    ctx.restore();
  }

  function renderTicket(image, template, record, nickname) {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const sx = canvas.width / REFERENCE_WIDTH;
    const sy = canvas.height / REFERENCE_HEIGHT;

    drawFittedText(ctx, nickname, template.nickname, sx, sy);

    record.numbers.forEach((number) => {
      const center = SHARED_GRID[number - 1];
      if (center) drawSelectedGridMark(ctx, center, number, template, sx, sy);
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
      const { template, image } = await pickRandomAvailableTemplate();
      const canvas = renderTicket(image, template, record, nickname);
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
        A.showToast("티켓 이미지를 찾지 못했습니다. assets/Yellow3.png, Red3.png, Green3.png, Blue3.png 파일을 확인하세요.");
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
