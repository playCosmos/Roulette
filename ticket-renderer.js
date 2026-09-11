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

  const TEMPLATES = [
    {
      id: "yellow",
      label: "yellow",
      paths: ["./assets/yellow.png", "./assets/lotto-yellow.png", "./assets/lotto-gold.png"],
      nickname: { x: 1418, y: 342, maxWidth: 126, maxHeight: 52 },
      markRadius: 25,
      grid: [
        [747,531],[829,539],[909,539],[992,532],[1069,535],[1150,532],[1227,543],
        [747,601],[831,599],[909,597],[991,601],[1067,601],[1150,599],[1231,599],
        [747,665],[829,673],[907,667],[991,667],[1070,665],[1150,667],[1229,667],
        [752,733],[831,733],[907,731],[991,733],[1069,734],[1145,733],[1227,731]
      ],
      selected: [[752,869],[832,871],[922,871],[1010,871],[1088,865],[1178,871],[1258,869]]
    },
    {
      id: "red",
      label: "red",
      paths: ["./assets/red.png", "./assets/lotto-red.png", "./assets/lotto-pink.png"],
      nickname: { x: 1414, y: 340, maxWidth: 126, maxHeight: 52 },
      markRadius: 25,
      grid: [
        [753,531],[831,535],[908,532],[987,530],[1066,530],[1148,535],[1227,538],
        [753,597],[829,595],[908,597],[989,604],[1071,598],[1148,599],[1227,601],
        [753,661],[829,664],[908,664],[987,663],[1066,663],[1148,668],[1227,665],
        [752,727],[831,733],[909,735],[987,731],[1066,730],[1150,729],[1226,731]
      ],
      selected: [[754,860],[836,860],[919,863],[1005,865],[1085,860],[1173,860],[1252,866]]
    },
    {
      id: "green",
      label: "green",
      paths: ["./assets/green.png", "./assets/lotto-green.png"],
      nickname: { x: 1406, y: 341, maxWidth: 126, maxHeight: 52 },
      markRadius: 25,
      grid: [
        [748,523],[823,521],[904,527],[980,523],[1064,521],[1141,527],[1220,529],
        [746,595],[825,595],[907,591],[982,589],[1059,591],[1141,596],[1217,591],
        [748,661],[825,658],[905,661],[982,659],[1061,659],[1141,657],[1220,664],
        [746,731],[823,728],[907,730],[982,731],[1061,725],[1141,724],[1220,723]
      ],
      selected: [[754,853],[837,854],[920,853],[999,858],[1076,849],[1156,852],[1235,855]]
    },
    {
      id: "blue",
      label: "blue",
      paths: ["./assets/blue.png", "./assets/lotto-blue.png"],
      nickname: { x: 1406, y: 337, maxWidth: 126, maxHeight: 52 },
      markRadius: 25,
      grid: [
        [753,530],[830,530],[907,525],[982,523],[1063,529],[1139,529],[1214,530],
        [753,591],[830,589],[907,591],[983,591],[1058,592],[1136,589],[1213,590],
        [753,661],[830,658],[907,659],[981,662],[1060,657],[1137,662],[1213,658],
        [753,724],[830,723],[904,729],[986,730],[1059,723],[1137,728],[1214,727]
      ],
      selected: [[753,857],[833,857],[915,859],[991,853],[1070,857],[1148,860],[1225,860]]
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
      outputHint.textContent = "체크하면 발급 완료 시 yellow / red / green / blue 중 랜덤 1장 PNG 저장";
      outputHint.classList.remove("ready");
      return;
    }

    outputHint.textContent = ready
      ? "이미지 출력 ON · 각 조합마다 랜덤 색상 시트를 PNG로 저장"
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

  function drawSelectedGridMark(ctx, center, number, template, sx, sy) {
    const x = center[0] * sx;
    const y = center[1] * sy;
    const radius = template.markRadius * Math.min(sx, sy);

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 0, 0, .94)";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyCanvasFont(ctx, Math.max(14, 22 * sy), 900, "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
    ctx.fillText(String(number), x, y + 0.5 * sy);
    ctx.restore();
  }

  function drawSelectedRow(ctx, numbers, template, sx, sy) {
    ctx.save();
    ctx.fillStyle = "#080808";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    applyCanvasFont(ctx, Math.max(16, 27 * sy), 900, "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
    numbers.forEach((number, index) => {
      const center = template.selected[index];
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
      const center = template.grid[number - 1];
      if (center) drawSelectedGridMark(ctx, center, number, template, sx, sy);
    });
    drawSelectedRow(ctx, record.numbers, template, sx, sy);
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
        A.showToast("티켓 이미지를 찾지 못했습니다. assets/yellow.png, red.png, green.png, blue.png 파일을 확인하세요.");
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
