(() => {
  "use strict";

  const MIN_COLUMNS = 8;
  const MIN_ROWS = 6;
  const MAX_COLUMNS = 64;
  const MAX_ROWS = 48;
  const STEP_DELAY_MS = 220;

  const params = new URLSearchParams(window.location.search);
  const DEMO_MODE = params.get("demo") === "1";
  const DEMO_PLAYER_COUNT = Math.min(
    12,
    Math.max(1, Number.parseInt(params.get("players") || "3", 10) || 3)
  );

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeDimension(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed, min, max);
  }

  function perimeterCellCount(columns, rows) {
    return (columns * 2) + ((rows - 2) * 2);
  }

  const defaultColumns = DEMO_MODE ? 16 : 8;
  const defaultRows = DEMO_MODE ? 12 : 6;

  const board = {
    columns: normalizeDimension(params.get("cols"), defaultColumns, MIN_COLUMNS, MAX_COLUMNS),
    rows: normalizeDimension(params.get("rows"), defaultRows, MIN_ROWS, MAX_ROWS)
  };
  board.cellCount = perimeterCellCount(board.columns, board.rows);

  const state = {
    totalLaps: 0,
    currentPhaseId: "phase-1",
    players: new Map(),
    moveQueues: new Map(),
    phasePlan: [
      {
        id: "phase-1",
        minTotalLaps: 0,
        label: "PHASE 1",
        description: "기본 보드",
        cells: {}
      }
    ]
  };

  const refs = {
    boardStage: document.getElementById("boardStage"),
    boardGrid: document.getElementById("boardGrid"),
    eventMessage: document.getElementById("eventMessage")
  };

  const cellElements = new Map();

  function normalizeCell(index) {
    const numeric = Number.parseInt(index, 10);
    if (!Number.isFinite(numeric)) return 0;
    return ((numeric % board.cellCount) + board.cellCount) % board.cellCount;
  }

  function circularDistance(a, b) {
    const direct = Math.abs(a - b);
    return Math.min(direct, board.cellCount - direct);
  }

  function currentPhase() {
    return state.phasePlan.find((phase) => phase.id === state.currentPhaseId) || state.phasePlan[0];
  }

  function cellDefinition(index) {
    const phase = currentPhase();
    const configured = phase?.cells?.[index] || {};
    return {
      label: configured.label || (index === 0 ? "START / LAP" : `칸 ${index + 1}`),
      command: configured.command || null,
      kind: configured.kind || (index === 0 ? "start" : "normal")
    };
  }

  function setEventMessage(message) {
    if (refs.eventMessage) refs.eventMessage.textContent = message;
  }

  function renderGlobalState() {
    if (!refs.boardStage) return;
    refs.boardStage.dataset.phase = state.currentPhaseId;
    refs.boardStage.dataset.totalLaps = String(state.totalLaps);
    refs.boardStage.dataset.playerCount = String(state.players.size);
    refs.boardStage.dataset.columns = String(board.columns);
    refs.boardStage.dataset.rows = String(board.rows);
    refs.boardStage.dataset.cellCount = String(board.cellCount);
    if (refs.boardGrid) {
      refs.boardGrid.setAttribute(
        "aria-label",
        `${board.columns}×${board.rows} 외곽 ${board.cellCount}칸 루프 보드`
      );
    }
  }

  function buildBoard() {
    if (!refs.boardGrid) return;

    refs.boardGrid.innerHTML = "";
    cellElements.clear();

    for (let index = 0; index < board.cellCount; index += 1) {
      const definition = cellDefinition(index);

      const cell = document.createElement("article");
      cell.className = "board-cell";
      cell.dataset.cellIndex = String(index);
      cell.dataset.kind = definition.kind;
      cell.dataset.occupied = "false";

      const number = document.createElement("span");
      number.className = "cell-index";
      number.textContent = String(index + 1).padStart(2, "0");

      const label = document.createElement("span");
      label.className = "cell-label";
      label.textContent = definition.command || definition.label;

      const tokens = document.createElement("div");
      tokens.className = "token-stack";
      tokens.dataset.tokensFor = String(index);

      cell.append(number, label, tokens);
      refs.boardGrid.append(cell);
      cellElements.set(index, cell);
    }

    renderPlayers();
  }

  function occupancyByCell() {
    const occupancy = new Map();
    for (const player of state.players.values()) {
      occupancy.set(player.position, (occupancy.get(player.position) || 0) + 1);
    }
    return occupancy;
  }

  function dockScales() {
    const playerPositions = Array.from(state.players.values(), (player) => player.position);

    if (!playerPositions.length) {
      return Array.from({ length: board.cellCount }, () => 1);
    }

    const playerCount = playerPositions.length;
    const density = Math.sqrt(board.cellCount / 24);
    const intensity = clamp(1 / Math.sqrt(Math.max(1, playerCount) * 0.68), 0.52, 1);

    // 칸이 많아질수록 비활성 칸은 더 작게, 현재 칸은 더 크게 잡아서
    // 16:9 방송 화면에서도 플레이어가 위치한 칸을 충분히 읽을 수 있게 한다.
    const restScale = clamp(
      0.70 - ((density - 1) * 0.20) + ((1 - intensity) * 0.08),
      0.46,
      0.76
    );
    const peakRange = (0.84 + ((density - 1) * 1.12)) * intensity;
    const maxScale = clamp(1.60 + ((density - 1) * 1.45), 1.60, 2.75);
    const proximityProfile = [1, 0.60, 0.32, density > 1.35 ? 0.12 : 0];

    return Array.from({ length: board.cellCount }, (_, cellIndex) => {
      let remaining = 1;
      let exactOccupancy = 0;

      for (const position of playerPositions) {
        const distance = circularDistance(cellIndex, position);
        if (distance === 0) exactOccupancy += 1;
        const localInfluence = distance < proximityProfile.length ? proximityProfile[distance] : 0;
        remaining *= (1 - localInfluence);
      }

      const combinedInfluence = 1 - remaining;
      const occupancyBoost = exactOccupancy > 1
        ? Math.min(0.16, Math.log2(exactOccupancy) * 0.045 * density * intensity)
        : 0;

      return clamp(
        restScale + (peakRange * combinedInfluence) + occupancyBoost,
        restScale,
        maxScale
      );
    });
  }

  function createRoundedPerimeter(width, height, inset, maxHalfWidth, maxHalfHeight) {
    const left = inset + maxHalfWidth;
    const right = width - inset - maxHalfWidth;
    const top = inset + maxHalfHeight;
    const bottom = height - inset - maxHalfHeight;

    const usableWidth = Math.max(80, right - left);
    const usableHeight = Math.max(80, bottom - top);
    const radius = clamp(
      Math.min(usableWidth, usableHeight) * 0.085,
      18,
      Math.min(usableWidth, usableHeight) * 0.18
    );

    const horizontal = Math.max(1, usableWidth - (radius * 2));
    const vertical = Math.max(1, usableHeight - (radius * 2));
    const quarterArc = Math.PI * radius * 0.5;
    const perimeter = (horizontal * 2) + (vertical * 2) + (quarterArc * 4);

    return {
      left,
      right,
      top,
      bottom,
      radius,
      horizontal,
      vertical,
      quarterArc,
      perimeter
    };
  }

  function roundedPerimeterPoint(path, distance) {
    const {
      left,
      right,
      top,
      bottom,
      radius,
      horizontal,
      vertical,
      quarterArc,
      perimeter
    } = path;

    let s = ((distance % perimeter) + perimeter) % perimeter;

    if (s < horizontal) {
      return { x: left + radius + s, y: top, angle: 0, cornerBlend: 0 };
    }
    s -= horizontal;

    if (s < quarterArc) {
      const progress = s / quarterArc;
      const angle = (-Math.PI / 2) + (progress * Math.PI / 2);
      return {
        x: right - radius + (Math.cos(angle) * radius),
        y: top + radius + (Math.sin(angle) * radius),
        angle: progress * Math.PI / 2,
        cornerBlend: Math.sin(progress * Math.PI)
      };
    }
    s -= quarterArc;

    if (s < vertical) {
      return { x: right, y: top + radius + s, angle: Math.PI / 2, cornerBlend: 0 };
    }
    s -= vertical;

    if (s < quarterArc) {
      const progress = s / quarterArc;
      const angle = progress * Math.PI / 2;
      return {
        x: right - radius + (Math.cos(angle) * radius),
        y: bottom - radius + (Math.sin(angle) * radius),
        angle: (Math.PI / 2) + (progress * Math.PI / 2),
        cornerBlend: Math.sin(progress * Math.PI)
      };
    }
    s -= quarterArc;

    if (s < horizontal) {
      return { x: right - radius - s, y: bottom, angle: Math.PI, cornerBlend: 0 };
    }
    s -= horizontal;

    if (s < quarterArc) {
      const progress = s / quarterArc;
      const angle = (Math.PI / 2) + (progress * Math.PI / 2);
      return {
        x: left + radius + (Math.cos(angle) * radius),
        y: bottom - radius + (Math.sin(angle) * radius),
        angle: Math.PI + (progress * Math.PI / 2),
        cornerBlend: Math.sin(progress * Math.PI)
      };
    }
    s -= quarterArc;

    if (s < vertical) {
      return { x: left, y: bottom - radius - s, angle: Math.PI * 1.5, cornerBlend: 0 };
    }
    s -= vertical;

    const progress = clamp(s / quarterArc, 0, 1);
    const angle = Math.PI + (progress * Math.PI / 2);
    return {
      x: left + radius + (Math.cos(angle) * radius),
      y: top + radius + (Math.sin(angle) * radius),
      angle: (Math.PI * 1.5) + (progress * Math.PI / 2),
      cornerBlend: Math.sin(progress * Math.PI)
    };
  }

  function projectedTangentSize(width, height, angle) {
    return (Math.abs(Math.cos(angle)) * width) + (Math.abs(Math.sin(angle)) * height);
  }

  function edgeAlignedPoint(point, cellWidth, cellHeight, width, height, inset) {
    const twoPi = Math.PI * 2;
    const angle = ((point.angle % twoPi) + twoPi) % twoPi;

    const leftX = inset + (cellWidth / 2);
    const rightX = width - inset - (cellWidth / 2);
    const topY = inset + (cellHeight / 2);
    const bottomY = height - inset - (cellHeight / 2);

    let x = point.x;
    let y = point.y;

    if (angle <= Math.PI / 2) {
      const t = angle / (Math.PI / 2);
      x += (rightX - x) * (t * t);
      y += (topY - y) * ((1 - t) * (1 - t));
    } else if (angle <= Math.PI) {
      const t = (angle - (Math.PI / 2)) / (Math.PI / 2);
      x += (rightX - x) * ((1 - t) * (1 - t));
      y += (bottomY - y) * (t * t);
    } else if (angle <= Math.PI * 1.5) {
      const t = (angle - Math.PI) / (Math.PI / 2);
      x += (leftX - x) * (t * t);
      y += (bottomY - y) * ((1 - t) * (1 - t));
    } else {
      const t = (angle - (Math.PI * 1.5)) / (Math.PI / 2);
      x += (leftX - x) * ((1 - t) * (1 - t));
      y += (topY - y) * (t * t);
    }

    return {
      x: clamp(x, leftX, rightX),
      y: clamp(y, topY, bottomY)
    };
  }

  function layoutBoardCells() {
    if (!refs.boardStage || !cellElements.size) return;

    const rect = refs.boardStage.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) return;

    const density = Math.sqrt(board.cellCount / 24);
    const axisDensity = Math.max(board.columns / MIN_COLUMNS, board.rows / MIN_ROWS);
    const gapDensity = Math.max(density, axisDensity);
    const inset = clamp(width * 0.0105, 10, 22);

    // 칸 수가 증가하면 확대할 공간을 확보하기 위해 기본 간격도 함께 줄인다.
    // 8×6에서는 기존 여백을 유지하고, 16×12에서는 대략 절반 수준,
    // 그 이상에서는 완만하게 2px까지 축소된다.
    const minGap = clamp(
      (width * 0.0048) / Math.pow(gapDensity, 0.92),
      2,
      12
    );

    const baseWidth = Math.max(1, (width - (inset * 2)) / board.columns);
    const baseHeight = Math.max(1, (height - (inset * 2)) / board.rows);
    const scales = dockScales();
    const occupancy = occupancyByCell();

    const desiredWidths = scales.map((scale) => baseWidth * scale);
    const desiredHeights = scales.map((scale) => baseHeight * scale);
    const maxHalfWidth = Math.max(...desiredWidths) * 0.5;
    const maxHalfHeight = Math.max(...desiredHeights) * 0.5;
    const path = createRoundedPerimeter(width, height, inset, maxHalfWidth, maxHalfHeight);

    let positions = Array.from(
      { length: board.cellCount },
      (_, index) => (index / board.cellCount) * path.perimeter
    );

    let fittedWidths = desiredWidths.slice();
    let fittedHeights = desiredHeights.slice();

    for (let iteration = 0; iteration < 7; iteration += 1) {
      const points = positions.map((position) => roundedPerimeterPoint(path, position));
      const projected = points.map((point, index) =>
        projectedTangentSize(fittedWidths[index], fittedHeights[index], point.angle)
      );

      const projectedTotal = projected.reduce((sum, size) => sum + size, 0);
      const availableForCells = Math.max(1, path.perimeter - (minGap * board.cellCount));
      const compression = Math.min(1, availableForCells / Math.max(1, projectedTotal));

      fittedWidths = desiredWidths.map((value) => value * compression);
      fittedHeights = desiredHeights.map((value) => value * compression);

      const refreshedProjected = points.map((point, index) =>
        projectedTangentSize(fittedWidths[index], fittedHeights[index], point.angle)
      );

      const requiredGaps = refreshedProjected.map((size, index) => {
        const next = refreshedProjected[(index + 1) % board.cellCount];
        return ((size + next) * 0.5) + minGap;
      });

      const requiredTotal = requiredGaps.reduce((sum, value) => sum + value, 0);
      const extra = Math.max(0, path.perimeter - requiredTotal);

      // 확대된 칸은 자기 크기만 더 차지한다.
      // 주변 여백까지 같이 커지지 않도록 남는 경로 길이는 모든 간격에 동일하게 분배한다.
      // 결과적으로 인접 칸의 edge-to-edge 간격은 가능한 한 일정하게 유지된다.
      const uniformSlack = extra / board.cellCount;

      const nextPositions = new Array(board.cellCount);
      nextPositions[0] = 0;

      for (let index = 1; index < board.cellCount; index += 1) {
        const previousGapIndex = index - 1;
        nextPositions[index] =
          nextPositions[index - 1] +
          requiredGaps[previousGapIndex] +
          uniformSlack;
      }

      positions = nextPositions;
    }

    for (let index = 0; index < board.cellCount; index += 1) {
      const cell = cellElements.get(index);
      if (!cell) continue;

      const point = roundedPerimeterPoint(path, positions[index]);
      const cornerCorrection = 1 - (point.cornerBlend * 0.075);
      const cellWidth = fittedWidths[index] * cornerCorrection;
      const cellHeight = fittedHeights[index] * cornerCorrection;
      const scale = scales[index];
      const isOccupied = occupancy.has(index);

      const renderedWidth = Math.max(1, cellWidth);
      const renderedHeight = Math.max(1, cellHeight);
      const alignedPoint = edgeAlignedPoint(
        point,
        renderedWidth,
        renderedHeight,
        width,
        height,
        inset
      );
      const snappedLeft = Math.round((alignedPoint.x - (renderedWidth / 2)) * 2) / 2;
      const snappedTop = Math.round((alignedPoint.y - (renderedHeight / 2)) * 2) / 2;
      const snappedWidth = Math.round(renderedWidth * 2) / 2;
      const snappedHeight = Math.round(renderedHeight * 2) / 2;

      cell.style.left = `${snappedLeft}px`;
      cell.style.top = `${snappedTop}px`;
      cell.style.width = `${snappedWidth}px`;
      cell.style.height = `${snappedHeight}px`;
      cell.style.setProperty("--dock-scale", (scale * cornerCorrection).toFixed(3));
      cell.style.zIndex = String(Math.round(scale * 100) + (isOccupied ? 200 : 0));
      cell.dataset.occupied = String(isOccupied);
      cell.dataset.dockScale = scale.toFixed(3);
      cell.dataset.cornerBlend = point.cornerBlend.toFixed(3);
      cell.dataset.pathAngle = point.angle.toFixed(3);
    }
  }

  function renderPlayers() {
    cellElements.forEach((cell) => {
      const stack = cell.querySelector(".token-stack");
      if (stack) stack.innerHTML = "";
    });

    for (const player of state.players.values()) {
      const cell = cellElements.get(player.position);
      const stack = cell?.querySelector(".token-stack");
      if (!stack) continue;

      const token = document.createElement("span");
      token.className = "player-token";
      token.dataset.playerId = player.id;
      token.title = player.name;
      token.textContent = player.shortLabel;
      stack.append(token);
    }

    renderGlobalState();
    layoutBoardCells();
  }

  function registerPlayer(input) {
    const id = String(input?.id || "").trim();
    const name = String(input?.name || id || "참가자").trim();
    if (!id) throw new Error("player id is required");

    const current = state.players.get(id);
    const player = {
      id,
      name,
      shortLabel: String(input?.shortLabel || name.slice(0, 2)).trim() || "P",
      position: normalizeCell(input?.position ?? current?.position ?? 0),
      laps: Math.max(0, Number.parseInt(input?.laps ?? current?.laps ?? 0, 10) || 0),
      pendingRolls: current?.pendingRolls || 0
    };

    state.players.set(id, player);
    renderPlayers();
    return { ...player };
  }

  function removePlayer(playerId) {
    const id = String(playerId);
    state.players.delete(id);
    state.moveQueues.delete(id);
    renderPlayers();
  }

  function setBoardDimensions(columns, rows) {
    const nextColumns = normalizeDimension(columns, board.columns, MIN_COLUMNS, MAX_COLUMNS);
    const nextRows = normalizeDimension(rows, board.rows, MIN_ROWS, MAX_ROWS);
    const previousCellCount = board.cellCount;
    const nextCellCount = perimeterCellCount(nextColumns, nextRows);

    if (
      nextColumns === board.columns &&
      nextRows === board.rows &&
      nextCellCount === board.cellCount
    ) {
      return getBoardDimensions();
    }

    for (const player of state.players.values()) {
      const progress = previousCellCount > 0 ? player.position / previousCellCount : 0;
      player.position = Math.min(
        nextCellCount - 1,
        Math.max(0, Math.round(progress * nextCellCount))
      );
    }

    board.columns = nextColumns;
    board.rows = nextRows;
    board.cellCount = nextCellCount;

    buildBoard();
    setEventMessage(
      `보드 크기 변경 · ${board.columns}×${board.rows} · 외곽 ${board.cellCount}칸`
    );

    window.dispatchEvent(new CustomEvent("ramyani-board:dimensionschange", {
      detail: getBoardDimensions()
    }));

    return getBoardDimensions();
  }

  function getBoardDimensions() {
    return {
      columns: board.columns,
      rows: board.rows,
      cells: board.cellCount
    };
  }

  function setPhasePlan(plan) {
    if (!Array.isArray(plan) || !plan.length) {
      throw new Error("phase plan must contain at least one phase");
    }

    state.phasePlan = plan
      .map((phase, index) => ({
        id: String(phase.id || `phase-${index + 1}`),
        minTotalLaps: Math.max(0, Number.parseInt(phase.minTotalLaps ?? 0, 10) || 0),
        label: String(phase.label || `PHASE ${index + 1}`),
        description: String(phase.description || ""),
        cells: phase.cells && typeof phase.cells === "object" ? phase.cells : {}
      }))
      .sort((a, b) => a.minTotalLaps - b.minTotalLaps);

    evaluatePhase(true);
  }

  function evaluatePhase(forceRender = false) {
    let next = state.phasePlan[0];

    for (const phase of state.phasePlan) {
      if (state.totalLaps >= phase.minTotalLaps) next = phase;
      else break;
    }

    const changed = next.id !== state.currentPhaseId;
    state.currentPhaseId = next.id;

    if (changed || forceRender) {
      buildBoard();
      renderGlobalState();

      if (changed) {
        setEventMessage(`전체 누적 ${state.totalLaps}바퀴 · ${next.label}로 판 전환`);
        window.dispatchEvent(new CustomEvent("ramyani-board:phasechange", {
          detail: {
            phaseId: next.id,
            totalLaps: state.totalLaps
          }
        }));
      }
    }
  }

  function destinationCommand(position) {
    return cellDefinition(position).command;
  }

  async function movePlayerBy(playerId, steps, meta = {}) {
    const player = state.players.get(String(playerId));
    if (!player) throw new Error(`unknown player: ${playerId}`);

    const distance = Math.max(0, Number.parseInt(steps, 10) || 0);
    if (!distance) return { ...player };

    for (let moved = 0; moved < distance; moved += 1) {
      const previous = player.position;
      player.position = normalizeCell(player.position + 1);

      if (previous === board.cellCount - 1 && player.position === 0) {
        player.laps += 1;
        state.totalLaps += 1;
        evaluatePhase();
      }

      renderPlayers();
      await delay(STEP_DELAY_MS);
    }

    const command = destinationCommand(player.position);
    const source = meta.source ? ` · ${meta.source}` : "";

    if (command) {
      setEventMessage(`${player.name}: ${command}${source}`);
      window.dispatchEvent(new CustomEvent("ramyani-board:command", {
        detail: {
          playerId: player.id,
          position: player.position,
          command,
          source: meta.source || null
        }
      }));
    } else {
      setEventMessage(`${player.name} → ${player.position + 1}번 칸${source}`);
    }

    return { ...player };
  }

  function enqueueRoll(playerId, diceValue, meta = {}) {
    const id = String(playerId);
    const player = state.players.get(id);
    if (!player) return Promise.reject(new Error(`unknown player: ${id}`));

    const dice = Math.max(1, Number.parseInt(diceValue, 10) || 1);
    player.pendingRolls += 1;
    renderPlayers();

    const previousQueue = state.moveQueues.get(id) || Promise.resolve();

    const nextQueue = previousQueue
      .catch(() => undefined)
      .then(async () => {
        player.pendingRolls = Math.max(0, player.pendingRolls - 1);
        renderPlayers();

        window.dispatchEvent(new CustomEvent("ramyani-board:roll", {
          detail: {
            playerId: id,
            dice,
            source: meta.source || null
          }
        }));

        return movePlayerBy(id, dice, meta);
      });

    state.moveQueues.set(id, nextQueue);
    return nextQueue;
  }

  function getSnapshot() {
    return {
      dimensions: getBoardDimensions(),
      totalLaps: state.totalLaps,
      currentPhaseId: state.currentPhaseId,
      players: Array.from(state.players.values()).map((player) => ({ ...player }))
    };
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function seedDemoPlayers(count) {
    for (let index = 0; index < count; index += 1) {
      const suffix = String.fromCharCode(65 + index);
      registerPlayer({
        id: `player-${index + 1}`,
        name: `참가자 ${suffix}`,
        shortLabel: suffix,
        position: Math.floor((index * board.cellCount) / count)
      });
    }
  }

  function startDemo() {
    seedDemoPlayers(DEMO_PLAYER_COUNT);
    setEventMessage(
      `Dock 강조 데모 · ${board.columns}×${board.rows} · 외곽 ${board.cellCount}칸 · 참가자 ${DEMO_PLAYER_COUNT}명`
    );

    window.setInterval(() => {
      const players = Array.from(state.players.values());
      if (!players.length) return;

      const player = players[Math.floor(Math.random() * players.length)];
      const dice = 1 + Math.floor(Math.random() * 6);
      enqueueRoll(player.id, dice, { source: "데모" }).catch(() => undefined);
    }, 2100);
  }

  const api = {
    MIN_COLUMNS,
    MIN_ROWS,
    MAX_COLUMNS,
    MAX_ROWS,
    registerPlayer,
    removePlayer,
    enqueueRoll,
    setBoardDimensions,
    getBoardDimensions,
    setPhasePlan,
    getSnapshot,
    layoutBoardCells
  };

  Object.defineProperties(api, {
    BOARD_COLUMNS: { enumerable: true, get: () => board.columns },
    BOARD_ROWS: { enumerable: true, get: () => board.rows },
    CELL_COUNT: { enumerable: true, get: () => board.cellCount }
  });

  window.RamyaniBoard = Object.freeze(api);

  buildBoard();
  renderGlobalState();

  if (window.ResizeObserver && refs.boardStage) {
    new ResizeObserver(layoutBoardCells).observe(refs.boardStage);
  } else {
    window.addEventListener("resize", layoutBoardCells);
  }

  if (DEMO_MODE) {
    startDemo();
  } else {
    setEventMessage(
      `${board.columns}×${board.rows} · 외곽 ${board.cellCount}칸 방송 오버레이 준비 완료`
    );
  }
})();
