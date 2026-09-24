(() => {
  "use strict";

  const MIN_COLUMNS = 8;
  const MIN_ROWS = 6;
  const MAX_COLUMNS = 64;
  const MAX_ROWS = 48;
  const MAX_PLAYERS = 6;
  const STEP_DELAY_MS = 220;

  // P0 geometry contract:
  // 1) every cell uses one shared aspect ratio,
  // 2) every cell scales uniformly in X/Y,
  // 3) every neighbor gap is one shared path gap,
  // 4) inactive cells all receive the same remaining-space base size.
  // 3~4명 중심의 강한 대비 프로파일.
  // 강조 칸이 둘레 공간을 더 가져가고 나머지 칸의 공통 base size가 줄어든다.
  const PLAYER_SCALE_PROFILE = [2.20, 1.52, 1.18, 1.04];
  const STACKED_PLAYER_BOOST = 0.34;
  const MAX_STACKED_SCALE = 3.40;

  const params = new URLSearchParams(window.location.search);
  const DEMO_MODE = params.get("demo") === "1";
  const DEMO_PLAYER_COUNT = Math.min(
    MAX_PLAYERS,
    Math.max(1, Number.parseInt(params.get("players") || "4", 10) || 4)
  );

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeDimension(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
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
  let layoutFrame = 0;

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
    const configured = phase && phase.cells ? (phase.cells[index] || {}) : {};

    return {
      label: configured.label || (index === 0 ? "START / LAP" : "칸 " + (index + 1)),
      command: configured.command || null,
      kind: configured.kind || (index === 0 ? "start" : "normal")
    };
  }

  function setEventMessage(message) {
    if (refs.eventMessage) refs.eventMessage.textContent = message;
  }

  function renderGlobalState() {
    if (!refs.boardStage) return;

    refs.boardStage.dataset.layoutEngine = "continuous-loop-v3";
    refs.boardStage.dataset.phase = state.currentPhaseId;
    refs.boardStage.dataset.totalLaps = String(state.totalLaps);
    refs.boardStage.dataset.playerCount = String(state.players.size);
    refs.boardStage.dataset.columns = String(board.columns);
    refs.boardStage.dataset.rows = String(board.rows);
    refs.boardStage.dataset.cellCount = String(board.cellCount);

    if (refs.boardGrid) {
      refs.boardGrid.setAttribute(
        "aria-label",
        board.columns + "×" + board.rows + " 외곽 " + board.cellCount + "칸 연속 루프 보드"
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
      if (!occupancy.has(player.position)) occupancy.set(player.position, []);
      occupancy.get(player.position).push(player);
    }

    return occupancy;
  }

  function scaleWeights() {
    const occupancy = occupancyByCell();
    const positions = Array.from(occupancy.keys());

    if (!positions.length) {
      return Array.from({ length: board.cellCount }, () => 1);
    }

    return Array.from({ length: board.cellCount }, (_, cellIndex) => {
      let weight = 1;

      for (const position of positions) {
        const distance = circularDistance(cellIndex, position);
        if (distance >= PLAYER_SCALE_PROFILE.length) continue;
        weight = Math.max(weight, PLAYER_SCALE_PROFILE[distance]);
      }

      const stackedCount = occupancy.get(cellIndex)?.length || 0;
      if (stackedCount > 1) {
        weight = Math.min(
          MAX_STACKED_SCALE,
          weight + ((stackedCount - 1) * STACKED_PLAYER_BOOST)
        );
      }

      return weight;
    });
  }

  function createRoundedLoop(width, height, margin, radius) {
    const left = margin;
    const right = width - margin;
    const top = margin;
    const bottom = height - margin;

    const innerWidth = Math.max(1, right - left);
    const innerHeight = Math.max(1, bottom - top);
    const r = clamp(radius, 1, Math.min(innerWidth, innerHeight) * 0.49);
    const horizontal = Math.max(0, innerWidth - (r * 2));
    const vertical = Math.max(0, innerHeight - (r * 2));
    const quarterArc = Math.PI * r * 0.5;
    const perimeter = (horizontal * 2) + (vertical * 2) + (quarterArc * 4);

    return {
      left,
      right,
      top,
      bottom,
      radius: r,
      horizontal,
      vertical,
      quarterArc,
      perimeter
    };
  }

  function loopPoint(path, distance) {
    const twoPi = Math.PI * 2;
    let s = ((distance % path.perimeter) + path.perimeter) % path.perimeter;

    if (s < path.horizontal) {
      return {
        x: path.left + path.radius + s,
        y: path.top,
        angle: 0,
        curved: false
      };
    }
    s -= path.horizontal;

    if (s < path.quarterArc) {
      const t = s / path.quarterArc;
      const phi = (-Math.PI / 2) + (t * Math.PI / 2);
      return {
        x: path.right - path.radius + (Math.cos(phi) * path.radius),
        y: path.top + path.radius + (Math.sin(phi) * path.radius),
        angle: phi + (Math.PI / 2),
        curved: true
      };
    }
    s -= path.quarterArc;

    if (s < path.vertical) {
      return {
        x: path.right,
        y: path.top + path.radius + s,
        angle: Math.PI / 2,
        curved: false
      };
    }
    s -= path.vertical;

    if (s < path.quarterArc) {
      const t = s / path.quarterArc;
      const phi = t * Math.PI / 2;
      return {
        x: path.right - path.radius + (Math.cos(phi) * path.radius),
        y: path.bottom - path.radius + (Math.sin(phi) * path.radius),
        angle: phi + (Math.PI / 2),
        curved: true
      };
    }
    s -= path.quarterArc;

    if (s < path.horizontal) {
      return {
        x: path.right - path.radius - s,
        y: path.bottom,
        angle: Math.PI,
        curved: false
      };
    }
    s -= path.horizontal;

    if (s < path.quarterArc) {
      const t = s / path.quarterArc;
      const phi = (Math.PI / 2) + (t * Math.PI / 2);
      return {
        x: path.left + path.radius + (Math.cos(phi) * path.radius),
        y: path.bottom - path.radius + (Math.sin(phi) * path.radius),
        angle: phi + (Math.PI / 2),
        curved: true
      };
    }
    s -= path.quarterArc;

    if (s < path.vertical) {
      return {
        x: path.left,
        y: path.bottom - path.radius - s,
        angle: Math.PI * 1.5,
        curved: false
      };
    }
    s -= path.vertical;

    const t = clamp(s / path.quarterArc, 0, 1);
    const phi = Math.PI + (t * Math.PI / 2);
    return {
      x: path.left + path.radius + (Math.cos(phi) * path.radius),
      y: path.top + path.radius + (Math.sin(phi) * path.radius),
      angle: (phi + (Math.PI / 2)) % twoPi,
      curved: true
    };
  }

  function rectangleCorners(centerX, centerY, width, height) {
    const halfWidth = width * 0.5;
    const halfHeight = height * 0.5;

    return [
      { x: centerX - halfWidth, y: centerY - halfHeight },
      { x: centerX + halfWidth, y: centerY - halfHeight },
      { x: centerX + halfWidth, y: centerY + halfHeight },
      { x: centerX - halfWidth, y: centerY + halfHeight }
    ];
  }

  function projectPolygon(points, axisX, axisY) {
    let min = Infinity;
    let max = -Infinity;

    for (const point of points) {
      const value = (point.x * axisX) + (point.y * axisY);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }

    return { min, max };
  }

  function polygonsOverlap(a, b) {
    for (const polygon of [a, b]) {
      for (let index = 0; index < polygon.length; index += 1) {
        const p0 = polygon[index];
        const p1 = polygon[(index + 1) % polygon.length];
        const edgeX = p1.x - p0.x;
        const edgeY = p1.y - p0.y;
        const length = Math.hypot(edgeX, edgeY);
        if (length <= 0.0001) continue;

        const axisX = -edgeY / length;
        const axisY = edgeX / length;
        const projectionA = projectPolygon(a, axisX, axisY);
        const projectionB = projectPolygon(b, axisX, axisY);

        if (
          projectionA.max <= projectionB.min ||
          projectionB.max <= projectionA.min
        ) {
          return false;
        }
      }
    }

    return true;
  }

  function pointSegmentDistance(point, a, b) {
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const lengthSquared = (edgeX * edgeX) + (edgeY * edgeY);

    if (lengthSquared <= 0.0001) {
      return Math.hypot(point.x - a.x, point.y - a.y);
    }

    const ratio = clamp(
      (((point.x - a.x) * edgeX) + ((point.y - a.y) * edgeY)) / lengthSquared,
      0,
      1
    );
    const closestX = a.x + (edgeX * ratio);
    const closestY = a.y + (edgeY * ratio);

    return Math.hypot(point.x - closestX, point.y - closestY);
  }

  function polygonDistance(a, b) {
    if (polygonsOverlap(a, b)) return 0;

    let distance = Infinity;

    for (const point of a) {
      for (let index = 0; index < b.length; index += 1) {
        distance = Math.min(
          distance,
          pointSegmentDistance(point, b[index], b[(index + 1) % b.length])
        );
      }
    }

    for (const point of b) {
      for (let index = 0; index < a.length; index += 1) {
        distance = Math.min(
          distance,
          pointSegmentDistance(point, a[index], a[(index + 1) % a.length])
        );
      }
    }

    return distance;
  }

  function cellGeometry(path, distance, cellWidth, cellHeight) {
    const point = loopPoint(path, distance);
    const inwardX = -Math.sin(point.angle);
    const inwardY = Math.cos(point.angle);

    let centerX = point.x + (inwardX * cellHeight * 0.5);
    let centerY = point.y + (inwardY * cellHeight * 0.5);
    // 코너에서도 셀 자체는 회전하지 않는다.
    // 중심 위치만 둥근 경로를 따라 이동하고 직사각형/텍스트는 항상 정방향을 유지한다.
    let corners = rectangleCorners(
      centerX,
      centerY,
      cellWidth,
      cellHeight
    );

    // 직선부는 margin 끝에 정확히 붙고, 코너/코너 주변에서만
    // 회전된 직사각형의 꼭짓점이 화면 밖으로 나가지 않도록
    // 보드 안쪽으로 필요한 만큼만 추가 이동한다.
    let extraInset = 0;

    for (const corner of corners) {
      if (corner.x < path.left && inwardX > 0.0001) {
        extraInset = Math.max(extraInset, (path.left - corner.x) / inwardX);
      }
      if (corner.x > path.right && inwardX < -0.0001) {
        extraInset = Math.max(extraInset, (corner.x - path.right) / -inwardX);
      }
      if (corner.y < path.top && inwardY > 0.0001) {
        extraInset = Math.max(extraInset, (path.top - corner.y) / inwardY);
      }
      if (corner.y > path.bottom && inwardY < -0.0001) {
        extraInset = Math.max(extraInset, (corner.y - path.bottom) / -inwardY);
      }
    }

    if (extraInset > 0) {
      centerX += inwardX * (extraInset + 0.25);
      centerY += inwardY * (extraInset + 0.25);
      corners = rectangleCorners(
        centerX,
        centerY,
        cellWidth,
        cellHeight
      );
    }

    return {
      distance,
      point,
      centerX,
      centerY,
      width: cellWidth,
      height: cellHeight,
      corners
    };
  }

  function findNextGeometry(path, previous, previousDistance, width, height, gap) {
    const step = Math.max(
      gap,
      width,
      height,
      previous.width,
      previous.height
    ) * 0.75 + gap;

    let low = previousDistance;
    let high = previousDistance + step;
    let candidate = cellGeometry(path, high, width, height);

    for (let guard = 0; guard < 12; guard += 1) {
      if (polygonDistance(previous.corners, candidate.corners) >= gap) break;
      high += step;
      candidate = cellGeometry(path, high, width, height);
    }

    for (let iteration = 0; iteration < 15; iteration += 1) {
      const middle = (low + high) * 0.5;
      const middleGeometry = cellGeometry(path, middle, width, height);
      const distance = polygonDistance(previous.corners, middleGeometry.corners);

      if (distance >= gap) {
        high = middle;
        candidate = middleGeometry;
      } else {
        low = middle;
      }
    }

    return {
      distance: high,
      geometry: candidate
    };
  }

  function placeLoop(path, baseWidth, aspect, weights, gap) {
    const widths = weights.map((weight) => baseWidth * weight);
    const heights = widths.map((width) => width / Math.max(0.01, aspect));

    const placements = new Array(board.cellCount);
    let currentDistance = 0;
    let current = cellGeometry(
      path,
      currentDistance,
      widths[0],
      heights[0]
    );
    placements[0] = current;

    for (let index = 1; index < board.cellCount; index += 1) {
      const next = findNextGeometry(
        path,
        current,
        currentDistance,
        widths[index],
        heights[index],
        gap
      );

      currentDistance = next.distance;
      current = next.geometry;
      placements[index] = current;
    }

    const closure = findNextGeometry(
      path,
      current,
      currentDistance,
      widths[0],
      heights[0],
      gap
    );

    return {
      placements,
      requiredPerimeter: closure.distance
    };
  }

  function solveLoop(path, aspect, weights, gap) {
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    let baseWidth = Math.max(
      1,
      (path.perimeter - (gap * board.cellCount)) / Math.max(1, weightTotal)
    );

    // 실제 직사각형 외곽 간 gap을 기준으로 한 바퀴가 정확히 닫히도록
    // baseWidth 하나만 보정한다. 모든 비강조 칸은 이 값으로 동일하다.
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const trial = placeLoop(path, baseWidth, aspect, weights, gap);
      const correction = clamp(
        path.perimeter / Math.max(1, trial.requiredPerimeter),
        0.80,
        1.20
      );
      baseWidth *= correction;
    }

    return {
      baseWidth,
      ...placeLoop(path, baseWidth, aspect, weights, gap)
    };
  }

  function applyCellGeometry(index, geometry, weight, occupied) {
    const cell = cellElements.get(index);
    if (!cell) return;

    const left = geometry.centerX - (geometry.width * 0.5);
    const top = geometry.centerY - (geometry.height * 0.5);
    const typographyBasis = Math.sqrt(geometry.width * geometry.height);
    const tokenBasis = Math.min(geometry.width, geometry.height);
    const indexFontSize = clamp(typographyBasis * 0.135, 8, 16);
    const labelFontSize = clamp(typographyBasis * 0.105, 7, 14);
    const tokenSize = clamp(tokenBasis * 0.42, 18, 58);
    const tokenFontSize = clamp(tokenSize * 0.34, 8, 15);

    cell.style.left = left.toFixed(3) + "px";
    cell.style.top = top.toFixed(3) + "px";
    cell.style.width = geometry.width.toFixed(3) + "px";
    cell.style.height = geometry.height.toFixed(3) + "px";
    cell.style.setProperty("--cell-index-font", indexFontSize.toFixed(3) + "px");
    cell.style.setProperty("--cell-label-font", labelFontSize.toFixed(3) + "px");
    cell.style.setProperty("--cell-token-size", tokenSize.toFixed(3) + "px");
    cell.style.setProperty("--cell-token-font", tokenFontSize.toFixed(3) + "px");
    cell.style.setProperty("--dock-scale", weight.toFixed(3));
    cell.style.zIndex = String(Math.round(weight * 100) + (occupied ? 200 : 0));

    cell.dataset.occupied = String(occupied);
    cell.dataset.dockScale = weight.toFixed(3);
    cell.dataset.curved = String(geometry.point.curved);
    cell.dataset.pathAngle = geometry.point.angle.toFixed(4);
  }

  function layoutNow() {
    layoutFrame = 0;
    if (!refs.boardStage || !refs.boardGrid || !cellElements.size) return;

    const rect = refs.boardStage.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) return;

    const weights = scaleWeights();
    const occupancy = occupancyByCell();

    const margin = clamp(Math.min(width, height) * 0.014, 8, 22);
    const nominalWidth = Math.max(1, (width - (margin * 2)) / board.columns);
    const nominalHeight = Math.max(1, (height - (margin * 2)) / board.rows);
    const aspect = nominalWidth / Math.max(1, nominalHeight);
    const nominalCell = Math.min(nominalWidth, nominalHeight);
    const gap = clamp(nominalCell * 0.075, 3, 11);
    const cornerRadius = clamp(
      nominalCell * 1.90,
      gap * 3,
      Math.min(width - (margin * 2), height - (margin * 2)) * 0.28
    );

    const path = createRoundedLoop(width, height, margin, cornerRadius);
    const solved = solveLoop(path, aspect, weights, gap);

    for (let index = 0; index < board.cellCount; index += 1) {
      applyCellGeometry(
        index,
        solved.placements[index],
        weights[index],
        occupancy.has(index)
      );
    }

    refs.boardGrid.dataset.pathPerimeter = path.perimeter.toFixed(3);
    refs.boardGrid.dataset.requiredPerimeter = solved.requiredPerimeter.toFixed(3);
    refs.boardGrid.dataset.cellGap = gap.toFixed(3);
    refs.boardGrid.dataset.cellAspect = aspect.toFixed(6);
    refs.boardGrid.dataset.baseCellWidth = solved.baseWidth.toFixed(3);
    refs.boardGrid.dataset.baseCellHeight = (
      solved.baseWidth / Math.max(0.01, aspect)
    ).toFixed(3);
  }

  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(layoutNow);
  }

  function createPlayerToken(player) {
    const token = document.createElement("span");
    token.className = "player-token";
    token.dataset.playerId = player.id;
    token.title = player.name;
    token.textContent = player.shortLabel;
    return token;
  }

  function renderPlayers() {
    const occupancy = occupancyByCell();

    cellElements.forEach((cell, index) => {
      const stack = cell.querySelector(".token-stack");
      if (!stack) return;

      stack.innerHTML = "";
      const players = occupancy.get(index) || [];

      for (const player of players.slice(0, MAX_PLAYERS)) {
        stack.append(createPlayerToken(player));
      }
    });

    renderGlobalState();
    scheduleLayout();
  }

  function registerPlayer(input) {
    const id = String((input && input.id) || "").trim();
    const name = String((input && input.name) || id || "참가자").trim();
    if (!id) throw new Error("player id is required");

    const current = state.players.get(id);
    if (!current && state.players.size >= MAX_PLAYERS) {
      throw new Error("maximum players: " + MAX_PLAYERS);
    }

    const player = {
      id,
      name,
      shortLabel: String((input && input.shortLabel) || name.slice(0, 2)).trim() || "P",
      position: normalizeCell(
        input && input.position !== undefined
          ? input.position
          : (current ? current.position : 0)
      ),
      laps: Math.max(
        0,
        Number.parseInt(
          input && input.laps !== undefined
            ? input.laps
            : (current ? current.laps : 0),
          10
        ) || 0
      ),
      pendingRolls: current ? current.pendingRolls : 0
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

  function getBoardDimensions() {
    return {
      columns: board.columns,
      rows: board.rows,
      cells: board.cellCount
    };
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
      "보드 크기 변경 · " + board.columns + "×" + board.rows + " · 외곽 " + board.cellCount + "칸"
    );

    window.dispatchEvent(new CustomEvent("ramyani-board:dimensionschange", {
      detail: getBoardDimensions()
    }));

    return getBoardDimensions();
  }

  function setPhasePlan(plan) {
    if (!Array.isArray(plan) || !plan.length) {
      throw new Error("phase plan must contain at least one phase");
    }

    state.phasePlan = plan
      .map((phase, index) => ({
        id: String(phase.id || "phase-" + (index + 1)),
        minTotalLaps: Math.max(0, Number.parseInt(phase.minTotalLaps || 0, 10) || 0),
        label: String(phase.label || "PHASE " + (index + 1)),
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
        setEventMessage(
          "전체 누적 " + state.totalLaps + "바퀴 · " + next.label + "로 판 전환"
        );
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

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function movePlayerBy(playerId, steps, meta = {}) {
    const player = state.players.get(String(playerId));
    if (!player) throw new Error("unknown player: " + playerId);

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
    const source = meta.source ? " · " + meta.source : "";

    if (command) {
      setEventMessage(player.name + ": " + command + source);
      window.dispatchEvent(new CustomEvent("ramyani-board:command", {
        detail: {
          playerId: player.id,
          position: player.position,
          command,
          source: meta.source || null
        }
      }));
    } else {
      setEventMessage(player.name + " → " + (player.position + 1) + "번 칸" + source);
    }

    return { ...player };
  }

  function enqueueRoll(playerId, diceValue, meta = {}) {
    const id = String(playerId);
    const player = state.players.get(id);
    if (!player) return Promise.reject(new Error("unknown player: " + id));

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

  function seedDemoPlayers(count) {
    for (let index = 0; index < count; index += 1) {
      const suffix = String.fromCharCode(65 + index);
      registerPlayer({
        id: "player-" + (index + 1),
        name: "참가자 " + suffix,
        shortLabel: suffix,
        position: Math.floor((index * board.cellCount) / count)
      });
    }
  }

  function startDemo() {
    seedDemoPlayers(DEMO_PLAYER_COUNT);
    setEventMessage(
      "Continuous Loop v3 · " +
      board.columns + "×" + board.rows +
      " · 외곽 " + board.cellCount +
      "칸 · 참가자 " + DEMO_PLAYER_COUNT + "명"
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
    MAX_PLAYERS,
    registerPlayer,
    removePlayer,
    enqueueRoll,
    setBoardDimensions,
    getBoardDimensions,
    setPhasePlan,
    getSnapshot,
    layoutBoardCells: layoutNow
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
    new ResizeObserver(scheduleLayout).observe(refs.boardStage);
  } else {
    window.addEventListener("resize", scheduleLayout);
  }

  if (DEMO_MODE) {
    startDemo();
  } else {
    setEventMessage(
      board.columns + "×" + board.rows +
      " · 외곽 " + board.cellCount +
      "칸 방송 오버레이 준비 완료"
    );
  }
})();
