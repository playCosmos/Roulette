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

  // AI 생성 시트마다 번호 칸의 크기·찌그러짐이 다르므로
  // 중심 좌표뿐 아니라 마킹 형상/경계 추적 파라미터도 색상별로 따로 둔다.
  const TEMPLATES = [
    {
      id: "yellow",
      label: "yellow",
      paths: ["./assets/yellow.png", "./assets/lotto-yellow.png", "./assets/lotto-gold.png"],
      nickname: { x: 1418, y: 342, maxWidth: 126, maxHeight: 52 },
      mark: { rx: 24.5, ry: 21.8, exponent: 2.45, search: 8.0, inset: 2.2, traceClamp: 7.0, samples: 72, fontSize: 21.5, textDx: 0, textDy: 0.5 },
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
      mark: { rx: 24.2, ry: 21.0, exponent: 2.7, search: 8.5, inset: 2.3, traceClamp: 7.2, samples: 72, fontSize: 21.5, textDx: 0, textDy: 0.5 },
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
      mark: { rx: 23.6, ry: 21.7, exponent: 2.3, search: 8.0, inset: 2.1, traceClamp: 6.8, samples: 72, fontSize: 21.0, textDx: 0, textDy: 0.3 },
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
      mark: { rx: 23.8, ry: 20.9, exponent: 2.6, search: 8.5, inset: 2.2, traceClamp: 7.0, samples: 72, fontSize: 21.0, textDx: 0, textDy: 0.4 },
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
  const imagePixelCache = new WeakMap();
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
      ? "이미지 출력 ON · 선택된 시트의 실제 번호 칸 경계를 따라 검게 채움"
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

  function getImagePixels(image) {
    if (imagePixelCache.has(image)) return imagePixelCache.get(image);

    try {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      const pixels = { data: imageData.data, width, height };
      imagePixelCache.set(image, pixels);
      return pixels;
    } catch (error) {
      console.warn("티켓 칸 경계 분석을 사용할 수 없어 기본 마스크를 사용합니다.", error);
      imagePixelCache.set(image, null);
      return null;
    }
  }

  function sampleLuma(pixels, x, y) {
    if (!pixels) return 128;
    const px = Math.max(0, Math.min(pixels.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(pixels.height - 1, Math.round(y)));
    const offset = (py * pixels.width + px) * 4;
    const data = pixels.data;
    return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
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

  function circularMedian(values, index, radius = 2) {
    const sample = [];
    for (let offset = -radius; offset <= radius; offset++) {
      sample.push(values[(index + offset + values.length) % values.length]);
    }
    sample.sort((a, b) => a - b);
    return sample[Math.floor(sample.length / 2)];
  }

  function buildFrameMatchedPath(ctx, pixels, center, profile, sx, sy) {
    const cx = center[0] * sx;
    const cy = center[1] * sy;
    const scale = Math.min(sx, sy);
    const rx = profile.rx * sx;
    const ry = profile.ry * sy;
    const search = profile.search * scale;
    const inset = profile.inset * scale;
    const clampRange = profile.traceClamp * scale;
    const samples = Math.max(40, profile.samples || 64);
    const step = Math.max(0.65, 0.8 * scale);
    const radii = [];
    const expectedRadii = [];

    for (let index = 0; index < samples; index++) {
      const angle = (index / samples) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const expected = superellipseRadius(rx, ry, profile.exponent, angle);
      expectedRadii.push(expected);

      if (!pixels) {
        radii.push(Math.max(3, expected - inset));
        continue;
      }

      const from = Math.max(7 * scale, expected - search);
      const to = expected + search;
      let bestRadius = expected;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (let radius = from; radius <= to; radius += step) {
        const innerRadius = Math.max(1, radius - 1.8 * scale);
        const outerRadius = radius + 1.8 * scale;
        const inner = sampleLuma(pixels, cx + cos * innerRadius, cy + sin * innerRadius);
        const current = sampleLuma(pixels, cx + cos * radius, cy + sin * radius);
        const outer = sampleLuma(pixels, cx + cos * outerRadius, cy + sin * outerRadius);

        // 번호 칸 내부 -> 테두리로 넘어갈 때 생기는 밝기 하락을 우선 사용한다.
        // 바깥 배경이 복잡해도 예상 경계에서 멀어질수록 페널티를 주어 다른 선을 잡지 않게 한다.
        const inwardDrop = inner - current;
        const localContrast = Math.abs(inner - current) + Math.abs(current - outer) * 0.35;
        const distancePenalty = Math.abs(radius - expected) * 0.72;
        const score = inwardDrop * 0.9 + localContrast * 0.35 - distancePenalty;

        if (score > bestScore) {
          bestScore = score;
          bestRadius = radius;
        }
      }

      if (bestScore < 7) bestRadius = expected;
      const traced = Math.max(expected - clampRange, Math.min(expected + clampRange, bestRadius));
      radii.push(Math.max(3, traced - inset));
    }

    const smoothed = radii.map((radius, index) => {
      const median = circularMedian(radii, index, 2);
      const expected = expectedRadii[index] - inset;
      return median * 0.86 + expected * 0.14;
    });

    ctx.beginPath();
    smoothed.forEach((radius, index) => {
      const angle = (index / samples) * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
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

  function drawSelectedGridMark(ctx, pixels, center, number, template, sx, sy) {
    const profile = template.mark;
    const x = center[0] * sx;
    const y = center[1] * sy;

    ctx.save();
    buildFrameMatchedPath(ctx, pixels, center, profile, sx, sy);
    ctx.fillStyle = "rgba(0, 0, 0, .965)";
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
    const sourcePixels = getImagePixels(image);

    drawFittedText(ctx, nickname, template.nickname, sx, sy);

    record.numbers.forEach((number) => {
      const center = template.grid[number - 1];
      if (center) drawSelectedGridMark(ctx, sourcePixels, center, number, template, sx, sy);
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
