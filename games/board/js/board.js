(() => {
  "use strict";

  const MIN_COLUMNS = 8;
  const MIN_ROWS = 6;
  const MAX_COLUMNS = 64;
  const MAX_ROWS = 48;
  const MAX_PLAYERS = 6;
  // 다음 스텝을 이전 전환이 완전히 끝나기 전에 시작해 연속 이동처럼 보이게 한다.
  const STEP_DELAY_MS = 250;

  // P0 geometry contract:
  // 1) every cell uses one shared aspect ratio,
  // 2) every cell scales uniformly in X/Y,
  // 3) every neighbor gap is one shared path gap,
  // 4) inactive cells all receive the same remaining-space base size.
  // 3~4명 중심의 강한 대비 프로파일.
  // 강조 칸이 둘레 공간을 더 가져가고 나머지 칸의 공통 base size가 줄어든다.
  const PLAYER_SCALE_PROFILE = [2.00, 1.36, 1.10];
  const STACKED_PLAYER_BOOST = 0.34;
  const MAX_STACKED_SCALE = 3.40;

  const params = new URLSearchParams(window.location.search);
  const DEMO_MODE = params.get("demo") === "1";
  const ROOM_ID = String(params.get("roomId") || "").trim();
  const ROOM_PREVIEW_MODE = params.get("preview") === "1";
  const ROOM_BOARD_SOURCE = params.get("board") === "committed" ? "committed" : "preview";
  const ROOM_WS_URL = String(params.get("ws") || "").trim();
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
  const playerTokenElements = new Map();
  const cellMotionStates = new Map();
  const tokenMotionStates = new Map();
  let layoutFrame = 0;
  let motionFrame = 0;
  let lastMotionTime = 0;
  let previousScaleWeights = null;
  let neutralSolveCache = null;
  // 중앙 Throw 연출은 화면이 하나이므로 FIFO로 직렬화한다.
  // 결과 공개 이후의 말 이동은 기존 플레이어별 큐에서 독립적으로 진행된다.
  let throwPresentationQueue = Promise.resolve();
  let roomTurnPlaybackQueue = Promise.resolve();

  const TOKEN_BASE_SIZE = 26;
  const INSTRUCTION_ZONE_RATIO = 0.35;
  const PLAYER_ZONE_RATIO = 0.65;
  const MOTION_EPSILON = 0.025;
  const VELOCITY_EPSILON = 0.04;

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

    refs.boardStage.dataset.layoutEngine = "reserve-first-loop-v4";
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

    if (refs.boardStage) {
      refs.boardStage.dataset.layoutReady = "false";
    }

    refs.boardGrid.innerHTML = "";
    cellElements.clear();
    previousScaleWeights = null;
    neutralSolveCache = null;

    if (motionFrame) {
      window.cancelAnimationFrame(motionFrame);
      motionFrame = 0;
    }
    lastMotionTime = 0;
    cellMotionStates.clear();
    tokenMotionStates.clear();

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

      const instructionZone = document.createElement("span");
      instructionZone.className = "cell-instruction-zone";
      instructionZone.append(number, label);

      cell.append(instructionZone);
      refs.boardGrid.append(cell);
      cellElements.set(index, cell);
    }

    const playerLayer = document.createElement("div");
    playerLayer.className = "player-layer";
    playerLayer.setAttribute("aria-hidden", "true");
    refs.boardGrid.append(playerLayer);
    refs.playerLayer = playerLayer;

    playerTokenElements.clear();
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

    for (let iteration = 0; iteration < 24; iteration += 1) {
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

  function placeLoopWithWidths(path, widths, aspect, gap) {
    const heights = widths.map((width) => width / Math.max(0.01, aspect));

    // Neutral baseline 전용: 상단 직선 중앙에서 한 방향으로 폐합한다.
    const startOffset = path.horizontal * 0.5;
    const placements = new Array(board.cellCount);
    let currentDistance = startOffset;
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
      startOffset,
      requiredPerimeter: closure.distance - startOffset
    };
  }

  function findPreviousGeometry(path, next, nextDistance, width, height, gap) {
    const step = Math.max(
      gap,
      width,
      height,
      next.width,
      next.height
    ) * 0.75 + gap;

    let high = nextDistance;
    let low = nextDistance - step;
    let candidate = cellGeometry(path, low, width, height);

    for (let guard = 0; guard < 12; guard += 1) {
      if (polygonDistance(candidate.corners, next.corners) >= gap) break;
      low -= step;
      candidate = cellGeometry(path, low, width, height);
    }

    for (let iteration = 0; iteration < 24; iteration += 1) {
      const middle = (low + high) * 0.5;
      const middleGeometry = cellGeometry(path, middle, width, height);
      const distance = polygonDistance(middleGeometry.corners, next.corners);

      if (distance >= gap) {
        low = middle;
        candidate = middleGeometry;
      } else {
        high = middle;
      }
    }

    return {
      distance: low,
      geometry: candidate
    };
  }

  function placeLoopBidirectionalWithWidths(
    path,
    widths,
    aspect,
    gap,
    anchorDistance
  ) {
    const heights = widths.map((width) => width / Math.max(0.01, aspect));
    const placements = new Array(board.cellCount);
    const forwardEnd = Math.floor(board.cellCount * 0.5);
    const backwardEnd = forwardEnd + 1;

    placements[0] = cellGeometry(
      path,
      anchorDistance,
      widths[0],
      heights[0]
    );

    let current = placements[0];
    let currentDistance = anchorDistance;

    // START에서 진행 방향으로 절반만 누적 배치한다.
    for (let index = 1; index <= forwardEnd; index += 1) {
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

    current = placements[0];
    currentDistance = anchorDistance;

    // END부터 역방향으로 나머지 절반을 배치한다.
    // 따라서 END→START gap도 직접 계산되어 항상 동일 gap 대상이다.
    for (let index = board.cellCount - 1; index >= backwardEnd; index -= 1) {
      const previous = findPreviousGeometry(
        path,
        current,
        currentDistance,
        widths[index],
        heights[index],
        gap
      );
      currentDistance = previous.distance;
      current = previous.geometry;
      placements[index] = current;
    }

    const forwardFront = placements[forwardEnd];
    const backwardFront = placements[backwardEnd];
    const closureGap = polygonDistance(
      forwardFront.corners,
      backwardFront.corners
    );

    // 역방향 front는 anchor보다 음의 방향에 있으므로 한 바퀴를 더해
    // 두 front가 아직 순서상 교차하지 않았는지 확인한다.
    const forwardDistance = forwardFront.distance;
    const backwardDistance = backwardFront.distance + path.perimeter;
    const frontierArc = backwardDistance - forwardDistance;
    const frontierCrossed = frontierArc <= 0;

    return {
      placements,
      startOffset: anchorDistance,
      anchorDistance,
      closureGap,
      frontierArc,
      frontierCrossed,
      forwardEnd,
      backwardEnd,
      // 기존 진단 필드와 호환. 실제 승인 여부는 closureGap/validation으로 결정한다.
      requiredPerimeter:
        path.perimeter + (frontierCrossed ? gap : (gap - closureGap))
    };
  }

  function validatePlacements(placements, gap) {
    // P0: 모든 순환 인접쌍의 실제 외곽 간격이 같은 값이어야 한다.
    // 허용 오차는 렌더링 소수점/이분 탐색 오차만 허용한다.
    const gapTolerance = 0.05;
    const overlapTolerance = 0.08;
    const adjacentGaps = [];

    let minimumAdjacentGap = Infinity;
    let maximumAdjacentGap = -Infinity;
    let maximumGapError = 0;
    let gapMismatchPair = null;
    let collisionPair = null;

    for (let index = 0; index < placements.length; index += 1) {
      const nextIndex = (index + 1) % placements.length;
      const distance = polygonDistance(
        placements[index].corners,
        placements[nextIndex].corners
      );

      adjacentGaps.push(distance);
      minimumAdjacentGap = Math.min(minimumAdjacentGap, distance);
      maximumAdjacentGap = Math.max(maximumAdjacentGap, distance);

      const error = Math.abs(distance - gap);
      if (error > maximumGapError) {
        maximumGapError = error;
      }

      if (error > gapTolerance && gapMismatchPair === null) {
        gapMismatchPair = [index, nextIndex];
      }
    }

    // 인접하지 않은 칸은 동일 gap 대상은 아니지만 절대 겹쳐서는 안 된다.
    for (let a = 0; a < placements.length; a += 1) {
      for (let b = a + 1; b < placements.length; b += 1) {
        const isAdjacent =
          b === a + 1 ||
          (a === 0 && b === placements.length - 1);

        if (isAdjacent) continue;

        const distance = polygonDistance(
          placements[a].corners,
          placements[b].corners
        );

        if (distance <= overlapTolerance) {
          collisionPair = [a, b];
          break;
        }
      }

      if (collisionPair) break;
    }

    return {
      valid: gapMismatchPair === null && collisionPair === null,
      adjacentGaps,
      minimumAdjacentGap,
      maximumAdjacentGap,
      maximumGapError,
      gapTolerance,
      gapMismatchPair,
      collisionPair
    };
  }

  function solveUniformWidth(path, aspect, gap) {
    let low = 0.5;
    let high = Math.max(
      2,
      (path.perimeter - (gap * board.cellCount)) / Math.max(1, board.cellCount)
    ) * 2;

    const widthsFor = (value) =>
      Array.from({ length: board.cellCount }, () => value);

    let highTrial = placeLoopWithWidths(
      path,
      widthsFor(high),
      aspect,
      gap
    );

    for (
      let guard = 0;
      guard < 12 && highTrial.requiredPerimeter < path.perimeter;
      guard += 1
    ) {
      high *= 1.35;
      highTrial = placeLoopWithWidths(
        path,
        widthsFor(high),
        aspect,
        gap
      );
    }

    let lowTrial = placeLoopWithWidths(
      path,
      widthsFor(low),
      aspect,
      gap
    );

    for (let iteration = 0; iteration < 42; iteration += 1) {
      const middle = (low + high) * 0.5;
      const trial = placeLoopWithWidths(
        path,
        widthsFor(middle),
        aspect,
        gap
      );

      if (trial.requiredPerimeter > path.perimeter) {
        high = middle;
      } else {
        low = middle;
        lowTrial = trial;
      }
    }

    return {
      width: low,
      ...lowTrial
    };
  }

  function buildReservedWidths(
    neutralWidth,
    normalWidth,
    weights,
    emphasisFactor = 1
  ) {
    return weights.map((weight) => {
      if (weight <= 1.0001) return normalWidth;

      // Dock 배율은 실제 일반 칸(normalWidth)을 기준으로 정의한다.
      // 따라서 플레이어 1명 칸 2.00×는 화면에서도 항상 일반 칸의 정확히 2배다.
      const effectiveWeight = 1 + ((weight - 1) * emphasisFactor);
      return normalWidth * effectiveWeight;
    });
  }

  function solveNormalWidth(
    path,
    aspect,
    weights,
    gap,
    neutralWidth,
    emphasisFactor,
    anchorDistance
  ) {
    const normalIndices = [];
    for (let index = 0; index < weights.length; index += 1) {
      if (weights[index] <= 1.0001) normalIndices.push(index);
    }

    const trialFor = (normalWidth) => {
      const widths = buildReservedWidths(
        neutralWidth,
        normalWidth,
        weights,
        emphasisFactor
      );
      return {
        widths,
        ...placeLoopBidirectionalWithWidths(
          path,
          widths,
          aspect,
          gap,
          anchorDistance
        )
      };
    };

    if (!normalIndices.length) {
      const trial = trialFor(neutralWidth);
      return {
        normalWidth: neutralWidth,
        ...trial
      };
    }

    // 모든 배율은 실제 일반 칸 크기 기준이므로 초기값도
    // 강조 weight 총합을 포함한 전체 비율로 직접 추정한다.
    const effectiveWeightTotal = weights.reduce(
      (sum, weight) =>
        sum + (1 + ((Math.max(1, weight) - 1) * emphasisFactor)),
      0
    );
    const estimatedNormalWidth = Math.max(
      0.5,
      (path.perimeter - (gap * board.cellCount)) /
        Math.max(1, effectiveWeightTotal)
    );

    let low = 0.5;
    let high = Math.max(neutralWidth, estimatedNormalWidth * 1.5);
    let lowTrial = trialFor(low);

    if (lowTrial.frontierCrossed || lowTrial.closureGap < gap) {
      return null;
    }

    let highTrial = trialFor(high);
    for (
      let guard = 0;
      guard < 14 &&
      !highTrial.frontierCrossed &&
      highTrial.closureGap > gap;
      guard += 1
    ) {
      low = high;
      lowTrial = highTrial;
      high *= 1.25;
      highTrial = trialFor(high);
    }

    for (let iteration = 0; iteration < 42; iteration += 1) {
      const middle = (low + high) * 0.5;
      const trial = trialFor(middle);
      const tooLarge =
        trial.frontierCrossed ||
        trial.closureGap < gap;

      if (tooLarge) {
        high = middle;
      } else {
        low = middle;
        lowTrial = trial;
      }
    }

    return {
      normalWidth: low,
      ...lowTrial
    };
  }

  function solveReserveFirstLoop(path, aspect, weights, gap, anchorDistance) {
    const neutralKey = [
      board.cellCount,
      path.horizontal.toFixed(3),
      path.vertical.toFixed(3),
      path.radius.toFixed(3),
      aspect.toFixed(6),
      gap.toFixed(3)
    ].join(":");

    let neutral;
    if (neutralSolveCache && neutralSolveCache.key === neutralKey) {
      neutral = neutralSolveCache.value;
    } else {
      neutral = solveUniformWidth(path, aspect, gap);
      neutralSolveCache = {
        key: neutralKey,
        value: neutral
      };
    }

    let emphasisFactor = 1;

    // 일반 상황에서는 강조 크기를 100% 예약한다.
    // P0 충돌이 실제로 발생하는 경우에만 강조 초과분을 조금씩 낮춘다.
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const solved = solveNormalWidth(
        path,
        aspect,
        weights,
        gap,
        neutral.width,
        emphasisFactor,
        anchorDistance
      );

      if (!solved) {
        emphasisFactor *= 0.94;
        continue;
      }

      const validation = validatePlacements(solved.placements, gap);
      const result = {
        neutralWidth: neutral.width,
        emphasisFactor,
        gap,
        validation,
        ...solved
      };

      if (validation.valid) return result;

      emphasisFactor *= 0.94;
    }

    throw new Error(
      "P0 layout failure: reserve-first layout could not avoid overlap"
    );
  }

  function circularPathDistance(a, b, perimeter) {
    const direct = Math.abs(a - b);
    return Math.min(direct, perimeter - direct);
  }

  function buildPhysicalOrder(startSlot) {
    return Array.from(
      { length: board.cellCount },
      (_, physicalIndex) =>
        normalizeCell(physicalIndex - startSlot)
    );
  }

  function remapPlacementsToLogical(physicalPlacements, physicalOrder) {
    const logicalPlacements = new Array(board.cellCount);

    for (let physicalIndex = 0; physicalIndex < physicalOrder.length; physicalIndex += 1) {
      const logicalIndex = physicalOrder[physicalIndex];
      logicalPlacements[logicalIndex] = physicalPlacements[physicalIndex];
    }

    return logicalPlacements;
  }

  function solveTopLeftStartLoop(path, aspect, logicalWeights, gap) {
    // START 중심은 항상 좌상단 코너 곡선의 중앙에 고정한다.
    // 이후 칸은 START에서 시계/반시계 양방향으로 절반씩 배치하므로
    // 확대 변화가 한 방향으로 전체 루프에 누적되는 현상을 줄인다.
    const targetDistance =
      path.perimeter - (path.quarterArc * 0.5);

    const solved = solveReserveFirstLoop(
      path,
      aspect,
      logicalWeights,
      gap,
      targetDistance
    );

    return {
      ...solved,
      placements: solved.placements,
      physicalPlacements: solved.placements,
      physicalOrder: Array.from(
        { length: board.cellCount },
        (_, index) => index
      ),
      startPhysicalSlot: 0,
      startTargetDistance: targetDistance
    };
  }

  function motionSmoothTime(mode) {
    if (mode === "approach") return 0.15;
    if (mode === "release") return 0.20;
    if (mode === "token") return 0.20;
    return 0.20;
  }

  function smoothDamp(current, target, velocity, smoothTime, deltaTime) {
    const safeTime = Math.max(0.0001, smoothTime);
    const omega = 2 / safeTime;
    const x = omega * deltaTime;
    const decay = 1 / (1 + x + (0.48 * x * x) + (0.235 * x * x * x));
    const change = current - target;
    const temp = (velocity + (omega * change)) * deltaTime;
    const nextVelocity = (velocity - (omega * temp)) * decay;
    let nextValue = target + ((change + temp) * decay);

    if ((target - current > 0) === (nextValue > target)) {
      nextValue = target;
      return { value: nextValue, velocity: 0 };
    }

    return {
      value: nextValue,
      velocity: nextVelocity
    };
  }

  function stateNeedsMotion(state) {
    return (
      Math.abs(state.x - state.targetX) > MOTION_EPSILON ||
      Math.abs(state.y - state.targetY) > MOTION_EPSILON ||
      Math.abs(state.scale - state.targetScale) > 0.001 ||
      Math.abs(state.vx) > VELOCITY_EPSILON ||
      Math.abs(state.vy) > VELOCITY_EPSILON ||
      Math.abs(state.vs) > 0.002
    );
  }

  function applyMotionTransform(state) {
    state.element.style.transform =
      "translate3d(" +
      state.x.toFixed(3) + "px," +
      state.y.toFixed(3) + "px,0) scale(" +
      state.scale.toFixed(5) + ")";
  }

  function advanceMotionState(state, deltaTime) {
    const smoothTime = motionSmoothTime(state.mode);
    const x = smoothDamp(
      state.x,
      state.targetX,
      state.vx,
      smoothTime,
      deltaTime
    );
    const y = smoothDamp(
      state.y,
      state.targetY,
      state.vy,
      smoothTime,
      deltaTime
    );
    const scale = smoothDamp(
      state.scale,
      state.targetScale,
      state.vs,
      smoothTime,
      deltaTime
    );

    state.x = x.value;
    state.vx = x.velocity;
    state.y = y.value;
    state.vy = y.velocity;
    state.scale = scale.value;
    state.vs = scale.velocity;

    if (!stateNeedsMotion(state)) {
      state.x = state.targetX;
      state.y = state.targetY;
      state.scale = state.targetScale;
      state.vx = 0;
      state.vy = 0;
      state.vs = 0;
    }

    applyMotionTransform(state);
    return stateNeedsMotion(state);
  }

  function animateMotion(timestamp) {
    motionFrame = 0;

    const deltaTime = lastMotionTime
      ? clamp((timestamp - lastMotionTime) / 1000, 1 / 240, 1 / 30)
      : 1 / 60;
    lastMotionTime = timestamp;

    let moving = false;

    for (const state of cellMotionStates.values()) {
      if (!state.element.isConnected) continue;
      moving = advanceMotionState(state, deltaTime) || moving;
    }

    for (const state of tokenMotionStates.values()) {
      if (!state.element.isConnected) continue;
      moving = advanceMotionState(state, deltaTime) || moving;
    }

    if (moving) {
      motionFrame = window.requestAnimationFrame(animateMotion);
    } else {
      lastMotionTime = 0;
    }
  }

  function scheduleMotion() {
    if (motionFrame) return;

    let moving = false;
    for (const state of cellMotionStates.values()) {
      if (stateNeedsMotion(state)) {
        moving = true;
        break;
      }
    }

    if (!moving) {
      for (const state of tokenMotionStates.values()) {
        if (stateNeedsMotion(state)) {
          moving = true;
          break;
        }
      }
    }

    if (moving) {
      motionFrame = window.requestAnimationFrame(animateMotion);
    }
  }

  function setMotionTarget(map, key, element, targetX, targetY, targetScale, mode, snap) {
    let state = map.get(key);

    if (!state) {
      state = {
        element,
        x: targetX,
        y: targetY,
        scale: targetScale,
        vx: 0,
        vy: 0,
        vs: 0,
        targetX,
        targetY,
        targetScale,
        mode
      };
      map.set(key, state);
      applyMotionTransform(state);
      return;
    }

    state.element = element;
    state.targetX = targetX;
    state.targetY = targetY;
    state.targetScale = targetScale;
    state.mode = mode;

    if (snap) {
      state.x = targetX;
      state.y = targetY;
      state.scale = targetScale;
      state.vx = 0;
      state.vy = 0;
      state.vs = 0;
      applyMotionTransform(state);
    }
  }

  function instructionEdgeForGeometry(geometry) {
    const tangentX = Math.cos(geometry.point.angle);
    const tangentY = Math.sin(geometry.point.angle);
    const inwardX = -tangentY;
    const inwardY = tangentX;

    if (Math.abs(inwardY) >= Math.abs(inwardX)) {
      return inwardY >= 0 ? "top" : "bottom";
    }
    return inwardX >= 0 ? "left" : "right";
  }

  function playerZoneForGeometry(geometry) {
    const edge = instructionEdgeForGeometry(geometry);
    const left = geometry.centerX - (geometry.width * 0.5);
    const top = geometry.centerY - (geometry.height * 0.5);
    let minX = left;
    let maxX = left + geometry.width;
    let minY = top;
    let maxY = top + geometry.height;

    if (edge === "top") {
      minY += geometry.height * INSTRUCTION_ZONE_RATIO;
    } else if (edge === "bottom") {
      maxY -= geometry.height * INSTRUCTION_ZONE_RATIO;
    } else if (edge === "left") {
      minX += geometry.width * INSTRUCTION_ZONE_RATIO;
    } else {
      maxX -= geometry.width * INSTRUCTION_ZONE_RATIO;
    }

    return {
      edge,
      minX,
      maxX,
      minY,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      centerX: (minX + maxX) * 0.5,
      centerY: (minY + maxY) * 0.5,
      point: geometry.point
    };
  }

  function applyCellGeometry(
    index,
    geometry,
    baseWidth,
    baseHeight,
    weight,
    occupied,
    motionMode
  ) {
    const cell = cellElements.get(index);
    if (!cell) return;

    const baseTypography = Math.sqrt(baseWidth * baseHeight);
    const indexFontSize = clamp(baseTypography * 0.135, 8, 16);
    const labelFontSize = clamp(baseTypography * 0.105, 7, 14);
    const cellRadius = clamp(Math.min(baseWidth, baseHeight) * 0.09, 2, 10);
    const scale = geometry.width / Math.max(0.01, baseWidth);
    const targetX = geometry.centerX - (baseWidth * 0.5);
    const targetY = geometry.centerY - (baseHeight * 0.5);
    const snap = refs.boardStage.dataset.layoutReady !== "true";

    const baseWidthText = baseWidth.toFixed(3) + "px";
    const baseHeightText = baseHeight.toFixed(3) + "px";
    if (cell.style.width !== baseWidthText) cell.style.width = baseWidthText;
    if (cell.style.height !== baseHeightText) cell.style.height = baseHeightText;

    cell.style.setProperty("--cell-index-font", indexFontSize.toFixed(3) + "px");
    cell.style.setProperty("--cell-label-font", labelFontSize.toFixed(3) + "px");
    cell.style.setProperty("--cell-radius", cellRadius.toFixed(3) + "px");
    cell.style.zIndex = String(Math.round(weight * 100) + (occupied ? 200 : 0));

    cell.dataset.occupied = String(occupied);
    cell.dataset.motion = motionMode || "neutral";
    cell.dataset.compact = String(
      Math.min(geometry.width, geometry.height) <= 30
    );
    cell.dataset.dockScale = weight.toFixed(3);
    cell.dataset.curved = String(geometry.point.curved);
    cell.dataset.pathAngle = geometry.point.angle.toFixed(4);
    cell.dataset.instructionEdge = instructionEdgeForGeometry(geometry);
    cell.style.setProperty(
      "--instruction-zone-ratio",
      (INSTRUCTION_ZONE_RATIO * 100).toFixed(2) + "%"
    );
    cell.style.setProperty(
      "--player-zone-ratio",
      (PLAYER_ZONE_RATIO * 100).toFixed(2) + "%"
    );

    setMotionTarget(
      cellMotionStates,
      index,
      cell,
      targetX,
      targetY,
      scale,
      motionMode || "neutral",
      snap
    );
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
    const solved = solveTopLeftStartLoop(
      path,
      aspect,
      weights,
      gap
    );

    for (let index = 0; index < board.cellCount; index += 1) {
      const previousWeight =
        previousScaleWeights && Number.isFinite(previousScaleWeights[index])
          ? previousScaleWeights[index]
          : weights[index];

      let motionMode = "neutral";
      if (weights[index] > previousWeight + 0.001) {
        motionMode = "approach";
      } else if (weights[index] < previousWeight - 0.001) {
        motionMode = "release";
      }

      applyCellGeometry(
        index,
        solved.placements[index],
        solved.neutralWidth,
        solved.neutralWidth / Math.max(0.01, aspect),
        weights[index],
        occupancy.has(index),
        motionMode
      );
    }

    previousScaleWeights = weights.slice();
    layoutPlayerTokens(solved.placements, occupancy);
    scheduleMotion();

    refs.boardGrid.dataset.pathPerimeter = path.perimeter.toFixed(3);
    refs.boardGrid.dataset.requiredPerimeter = solved.requiredPerimeter.toFixed(3);
    refs.boardGrid.dataset.cellGap = solved.gap.toFixed(3);
    refs.boardGrid.dataset.minimumAdjacentGap =
      solved.validation.minimumAdjacentGap.toFixed(3);
    refs.boardGrid.dataset.maximumAdjacentGap =
      solved.validation.maximumAdjacentGap.toFixed(3);
    refs.boardGrid.dataset.maximumGapError =
      solved.validation.maximumGapError.toFixed(3);
    refs.boardGrid.dataset.equalGap = String(
      solved.validation.gapMismatchPair === null
    );
    refs.boardGrid.dataset.collisionFree = String(
      solved.validation.collisionPair === null
    );
    refs.boardGrid.dataset.cellAspect = aspect.toFixed(6);
    refs.boardGrid.dataset.neutralCellWidth = solved.neutralWidth.toFixed(3);
    refs.boardGrid.dataset.normalCellWidth = solved.normalWidth.toFixed(3);
    refs.boardGrid.dataset.emphasisFactor = solved.emphasisFactor.toFixed(4);
    refs.boardGrid.dataset.startPhysicalSlot = String(solved.startPhysicalSlot);
    refs.boardGrid.dataset.baseCellHeight = (
      solved.normalWidth / Math.max(0.01, aspect)
    ).toFixed(3);
    refs.boardGrid.dataset.closureGap = solved.closureGap.toFixed(3);
    refs.boardGrid.dataset.layoutAnchor = "start-bidirectional";

    // 첫 배치는 transition 없이 확정한다.
    // 모든 셀이 최종 좌표를 받은 뒤에만 이후 이동 애니메이션을 허용한다.
    if (refs.boardStage.dataset.layoutReady !== "true") {
      refs.boardStage.getBoundingClientRect();
      refs.boardStage.dataset.layoutReady = "true";
    }
  }

  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(layoutNow);
  }

  const BUBBLE_PIP_POSITIONS = {
    1: ["c"],
    2: ["tl", "br"],
    3: ["tl", "c", "br"],
    4: ["tl", "tr", "bl", "br"],
    5: ["tl", "tr", "c", "bl", "br"],
    6: ["tl", "ml", "bl", "tr", "mr", "br"]
  };

  function createPlayerToken(player) {
    const token = document.createElement("span");
    token.className = "player-token";
    token.dataset.playerId = player.id;
    token.title = player.name;

    const label = document.createElement("span");
    label.className = "player-token-label";
    label.textContent = player.shortLabel;

    const bubble = document.createElement("span");
    bubble.className = "player-result-bubble";
    bubble.dataset.visible = "false";

    token.append(label, bubble);
    return token;
  }

  function updatePlayerToken(token, player) {
    token.title = player.name;
    const label = token.querySelector(".player-token-label");
    if (label) label.textContent = player.shortLabel;
  }

  function createBubbleDie(value) {
    const die = document.createElement("span");
    die.className = "bubble-die";
    for (const position of BUBBLE_PIP_POSITIONS[value] || []) {
      const pip = document.createElement("span");
      pip.className = "bubble-pip";
      pip.dataset.position = position;
      die.append(pip);
    }
    return die;
  }

  function showPlayerResultBubble(playerId, event) {
    const token = playerTokenElements.get(String(playerId));
    if (!token) return;

    const bubble = token.querySelector(".player-result-bubble");
    if (!bubble) return;
    bubble.innerHTML = "";

    const presenter = window.RamyaniThrowPresentation;
    const data = presenter?.getBubbleData
      ? presenter.getBubbleData(event)
      : null;

    if (data?.generator === "dice") {
      for (const value of data.values) {
        bubble.append(createBubbleDie(value));
      }
    } else if (data?.generator === "yut") {
      const strip = document.createElement("span");
      strip.className = "bubble-yut-strip";
      for (const face of data.faces || []) {
        const piece = document.createElement("span");
        piece.className = "bubble-yut";
        piece.dataset.face = face.face;
        piece.dataset.special = String(Boolean(face.special));
        strip.append(piece);
      }
      bubble.append(strip);
    }

    const value = document.createElement("span");
    value.className = "player-result-bubble-value";
    value.textContent = data?.text || "";
    bubble.append(value);

    if (data?.bonus) {
      const bonus = document.createElement("span");
      bonus.className = "player-result-bubble-bonus";
      bonus.textContent = "↻";
      bonus.title = "한 번 더";
      bubble.append(bonus);
    }

    bubble.dataset.visible = "true";
  }

  function hidePlayerResultBubble(playerId) {
    const token = playerTokenElements.get(String(playerId));
    const bubble = token?.querySelector(".player-result-bubble");
    if (bubble) bubble.dataset.visible = "false";
  }

  function ensurePlayerTokens() {
    if (!refs.playerLayer) return;

    const activeIds = new Set();

    for (const player of state.players.values()) {
      activeIds.add(player.id);

      let token = playerTokenElements.get(player.id);
      if (!token) {
        token = createPlayerToken(player);
        playerTokenElements.set(player.id, token);
        refs.playerLayer.append(token);
      } else {
        updatePlayerToken(token, player);
      }
    }

    for (const [playerId, token] of playerTokenElements.entries()) {
      if (activeIds.has(playerId)) continue;
      token.remove();
      playerTokenElements.delete(playerId);
      tokenMotionStates.delete(playerId);
    }
  }

  function tokenLayout(count, tokenSize, geometry) {
    if (count <= 1) {
      return {
        tokenSize,
        slots: [{ tangent: 0, depth: 0 }]
      };
    }

    // 말 크기는 유지하고 인원 수별로 1~2줄에 배치한다.
    // 2명: 2
    // 3명: 2 + 1
    // 4명: 2 + 2
    // 5명: 3 + 2
    // 6명: 3 + 3
    const rows =
      count === 2 ? [2] :
      count === 3 ? [2, 1] :
      count === 4 ? [2, 2] :
      count === 5 ? [3, 2] :
      [3, 3];

    const horizontalEdge = geometry.point.segment === undefined
      ? Math.abs(Math.cos(geometry.point.angle)) >=
        Math.abs(Math.sin(geometry.point.angle))
      : geometry.point.segment % 2 === 0;

    const tangentSpan = horizontalEdge
      ? geometry.width
      : geometry.height;

    const edgePadding = 4;
    const maxRowCount = Math.max(...rows);
    const availableSpan = Math.max(
      tokenSize,
      tangentSpan - (edgePadding * 2)
    );
    const preferredSpacing = tokenSize * 0.78;
    const fitSpacing = maxRowCount > 1
      ? (availableSpan - tokenSize) / (maxRowCount - 1)
      : preferredSpacing;
    const spacing = clamp(
      Math.min(preferredSpacing, fitSpacing),
      tokenSize * 0.52,
      preferredSpacing
    );

    // 두 번째 줄은 테두리에서 셀 중앙 쪽으로 이동한다.
    // 말끼리는 약간 겹치도록 지름보다 작은 깊이 간격을 사용한다.
    const rowDepth = tokenSize * 0.72;
    const slots = [];

    rows.forEach((rowCount, rowIndex) => {
      for (let index = 0; index < rowCount; index += 1) {
        slots.push({
          tangent: (index - ((rowCount - 1) * 0.5)) * spacing,
          depth: -(rowIndex * rowDepth)
        });
      }
    });

    return { tokenSize, slots };
  }

  function layoutPlayerTokens(placements, occupancy) {
    ensurePlayerTokens();
    if (!refs.playerLayer) return;

    const snap = refs.boardStage.dataset.layoutReady !== "true";

    for (const [cellIndex, players] of occupancy.entries()) {
      const geometry = placements[cellIndex];
      if (!geometry) continue;

      const visiblePlayers = players.slice(0, MAX_PLAYERS);
      const playerZone = playerZoneForGeometry(geometry);
      const baseTokenSize = clamp(
        Math.min(playerZone.width, playerZone.height) * 0.58,
        18,
        62
      );
      const tokenSize = baseTokenSize;
      const layout = tokenLayout(
        visiblePlayers.length,
        tokenSize,
        playerZone
      );

      visiblePlayers.forEach((player, index) => {
        const token = playerTokenElements.get(player.id);
        if (!token) return;

        const slot = layout.slots[index] || { tangent: 0, depth: 0 };

        // 첫 줄은 보드 안쪽 테두리에 붙이고, 두 번째 줄은 셀 중앙 쪽으로
        // 한 줄만 이동한다. tangent 방향으로 펼쳐 각 말의 식별성을 유지한다.
        const tangentX = Math.cos(geometry.point.angle);
        const tangentY = Math.sin(geometry.point.angle);
        const inwardX = -tangentY;
        const inwardY = tangentX;
        const tokenRadius = tokenSize * 0.5;
        const edgePadding = 2;

        const maxOffsetX =
          Math.abs(inwardX) > 0.0001
            ? Math.max(
                0,
                ((playerZone.width * 0.5) - tokenRadius - edgePadding) /
                  Math.abs(inwardX)
              )
            : Infinity;
        const maxOffsetY =
          Math.abs(inwardY) > 0.0001
            ? Math.max(
                0,
                ((playerZone.height * 0.5) - tokenRadius - edgePadding) /
                  Math.abs(inwardY)
              )
            : Infinity;
        const inwardOffset = Math.min(maxOffsetX, maxOffsetY);

        let centerX =
          playerZone.centerX +
          (inwardX * (inwardOffset + slot.depth)) +
          (tangentX * slot.tangent);
        let centerY =
          playerZone.centerY +
          (inwardY * (inwardOffset + slot.depth)) +
          (tangentY * slot.tangent);

        // 토큰은 고정 65% 플레이어 영역 밖으로 절대 넘어가지 않는다.
        centerX = clamp(
          centerX,
          playerZone.minX + tokenRadius + edgePadding,
          playerZone.maxX - tokenRadius - edgePadding
        );
        centerY = clamp(
          centerY,
          playerZone.minY + tokenRadius + edgePadding,
          playerZone.maxY - tokenRadius - edgePadding
        );

        token.dataset.cellIndex = String(cellIndex);
        token.dataset.stacked = String(visiblePlayers.length > 1);

        if (Math.abs(inwardX) >= Math.abs(inwardY)) {
          token.dataset.bubbleSide = inwardX >= 0 ? "right" : "left";
        } else {
          token.dataset.bubbleSide = inwardY >= 0 ? "down" : "up";
        }
        token.style.setProperty(
          "--bubble-inverse-scale",
          String(TOKEN_BASE_SIZE / Math.max(1, tokenSize))
        );

        setMotionTarget(
          tokenMotionStates,
          player.id,
          token,
          centerX - (TOKEN_BASE_SIZE * 0.5),
          centerY - (TOKEN_BASE_SIZE * 0.5),
          tokenSize / TOKEN_BASE_SIZE,
          "token",
          snap
        );
      });
    }
  }

  function renderPlayers() {
    ensurePlayerTokens();
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

    const signedSteps = Number.parseInt(steps, 10) || 0;
    const direction = signedSteps < 0 ? -1 : 1;
    const distance = Math.abs(signedSteps);
    if (!distance) return { ...player };

    for (let moved = 0; moved < distance; moved += 1) {
      const previous = player.position;
      player.position = normalizeCell(player.position + direction);

      // 누적 바퀴는 정방향으로 START를 통과한 경우에만 증가한다.
      if (
        direction > 0 &&
        previous === board.cellCount - 1 &&
        player.position === 0
      ) {
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

  function normalizeThrowEvent(input) {
    const event = input && typeof input === "object" ? input : {};
    const playerId = String(event.playerId || "").trim();
    if (!playerId) throw new Error("throw event playerId is required");

    if (event.generator === "dice") {
      const values = Array.isArray(event.dice?.values)
        ? event.dice.values.slice(0, 2).map((value) => Number.parseInt(value, 10))
        : [];

      if (
        values.length < 1 ||
        values.some((value) => !Number.isFinite(value) || value < 1 || value > 6)
      ) {
        throw new Error("dice values must contain 1~2 d6 results");
      }

      const total = values.reduce((sum, value) => sum + value, 0);
      const resolvedSteps = Number.parseInt(event.resolvedSteps, 10);
      return {
        eventId: String(event.eventId || "local-" + Date.now()),
        playerId,
        generator: "dice",
        dice: {
          values,
          total,
          isDouble: values.length === 2 && values[0] === values[1]
        },
        steps: Number.isFinite(resolvedSteps) ? resolvedSteps : total,
        appliedMultiplier: Math.max(1, Number.parseInt(event.appliedMultiplier, 10) || 1),
        bonusThrow:
          values.length === 2 &&
          values[0] === values[1] &&
          event.bonusThrow !== false
      };
    }

    if (event.generator === "yut") {
      const name = String(event.yut?.name || "").toUpperCase();
      const stepByName = {
        BACK_DO: -1,
        DO: 1,
        GAE: 2,
        GEOL: 3,
        YUT: 4,
        MO: 5
      };
      if (!(name in stepByName)) {
        throw new Error("unknown yut result: " + name);
      }

      const resolvedSteps = Number.parseInt(event.resolvedSteps, 10);
      return {
        eventId: String(event.eventId || "local-" + Date.now()),
        playerId,
        generator: "yut",
        yut: {
          name,
          steps: stepByName[name],
          faces: Array.isArray(event.yut?.faces)
            ? event.yut.faces.slice(0, 4).map((face, index) => ({
                face: face?.face === "flat" ? "flat" : "convex",
                special: Boolean(face?.special) && index === 0
              }))
            : null
        },
        steps: Number.isFinite(resolvedSteps) ? resolvedSteps : stepByName[name],
        appliedMultiplier: Math.max(1, Number.parseInt(event.appliedMultiplier, 10) || 1),
        bonusThrow:
          (name === "YUT" || name === "MO") &&
          event.bonusThrow !== false
      };
    }

    throw new Error("throw generator must be dice or yut");
  }

  function reserveThrowPresentation(event, player) {
    let revealResolve;
    const reveal = new Promise((resolve) => {
      revealResolve = resolve;
    });

    const run = throwPresentationQueue
      .catch(() => undefined)
      .then(async () => {
        const presenter = window.RamyaniThrowPresentation;
        const presentation = presenter?.present
          ? presenter.present(event, player)
          : {
              reveal: Promise.resolve(),
              finished: Promise.resolve()
            };

        await presentation.reveal;
        revealResolve();
        await presentation.finished;
      });

    throwPresentationQueue = run;
    return {
      reveal,
      finished: run
    };
  }

  function enqueueThrowEvent(input, meta = {}) {
    let event;
    try {
      event = normalizeThrowEvent(input);
    } catch (error) {
      return Promise.reject(error);
    }

    const id = event.playerId;
    const player = state.players.get(id);
    if (!player) return Promise.reject(new Error("unknown player: " + id));

    player.pendingRolls += 1;
    renderPlayers();

    const previousQueue = state.moveQueues.get(id) || Promise.resolve();
    const nextQueue = previousQueue
      .catch(() => undefined)
      .then(async () => {
        player.pendingRolls = Math.max(0, player.pendingRolls - 1);
        renderPlayers();

        // 서버가 이미 확정한 event를 그대로 표현한다.
        // 클라이언트는 결과를 다시 추첨하지 않는다.
        const presentation = reserveThrowPresentation(event, player);

        window.dispatchEvent(new CustomEvent("ramyani-board:throwstarted", {
          detail: { event, source: meta.source || null }
        }));

        await presentation.reveal;

        showPlayerResultBubble(id, event);

        window.dispatchEvent(new CustomEvent("ramyani-board:throwrevealed", {
          detail: { event, source: meta.source || null }
        }));

        const movement = movePlayerBy(id, event.steps, {
          ...meta,
          source: meta.source || event.generator
        });

        try {
          // 추가 던지기 여부와 관계없이 현재 결과의 이동을 먼저 끝낸다.
          // 같은 플레이어의 다음 throw event는 이 Promise가 끝난 뒤에만 시작된다.
          const movedPlayer = await movement;

          window.dispatchEvent(new CustomEvent("ramyani-board:movementcompleted", {
            detail: {
              event,
              playerId: id,
              position: movedPlayer.position,
              bonusThrow: Boolean(event.bonusThrow),
              source: meta.source || null
            }
          }));

          // 중앙 결과 연출이 아직 남아 있다면 마무리까지 기다린다.
          // 단, 다음 추가 던지기는 반드시 이동 완료 이후에만 진행된다.
          await presentation.finished;
          return movedPlayer;
        } finally {
          await delay(180);
          hidePlayerResultBubble(id);
        }
      });

    state.moveQueues.set(id, nextQueue);
    return nextQueue;
  }

  // 기존 외부 호출 호환용: 단일 d6 결과를 서버 확정 이벤트 형태로 변환한다.
  function enqueueRoll(playerId, diceValue, meta = {}) {
    const value = clamp(Number.parseInt(diceValue, 10) || 1, 1, 6);
    return enqueueThrowEvent({
      eventId: "legacy-dice-" + Date.now(),
      playerId: String(playerId),
      generator: "dice",
      dice: { values: [value] },
      bonusThrow: false
    }, meta);
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

  function resolveDemoDice(playerId) {
    const values = [
      1 + Math.floor(Math.random() * 6),
      1 + Math.floor(Math.random() * 6)
    ];
    return {
      eventId: "demo-dice-" + Date.now() + "-" + playerId,
      playerId,
      generator: "dice",
      dice: { values },
      bonusThrow: values[0] === values[1]
    };
  }

  function resolveDemoYut(playerId) {
    // 첫 번째 윷이 뒷도 식별용 특수 윷이다.
    // flat=true인 개수로 도/개/걸/윷/모를 결정하고,
    // flat이 하나뿐이며 그 하나가 특수 윷이면 뒷도다.
    const flat = Array.from({ length: 4 }, () => Math.random() < 0.5);
    const flatCount = flat.filter(Boolean).length;

    let name;
    if (flatCount === 0) name = "MO";
    else if (flatCount === 4) name = "YUT";
    else if (flatCount === 3) name = "GEOL";
    else if (flatCount === 2) name = "GAE";
    else name = flat[0] ? "BACK_DO" : "DO";

    return {
      eventId: "demo-yut-" + Date.now() + "-" + playerId,
      playerId,
      generator: "yut",
      yut: { name },
      bonusThrow: name === "YUT" || name === "MO"
    };
  }

  async function runDemoTurn(player, generator) {
    let bonus = true;
    let safety = 0;

    while (bonus && safety < 6) {
      safety += 1;
      const event = generator === "yut"
        ? resolveDemoYut(player.id)
        : resolveDemoDice(player.id);

      await enqueueThrowEvent(event, { source: "데모" });
      bonus = event.bonusThrow;
      if (bonus) await delay(350);
    }
  }

  async function startDemo() {
    seedDemoPlayers(DEMO_PLAYER_COUNT);
    setEventMessage(
      "통합 Throw Overlay · " +
      board.columns + "×" + board.rows +
      " · 외곽 " + board.cellCount +
      "칸 · 참가자 " + DEMO_PLAYER_COUNT + "명"
    );

    const requested = String(params.get("throw") || "mixed").toLowerCase();

    while (DEMO_MODE) {
      const players = Array.from(state.players.values());
      if (!players.length) {
        await delay(1000);
        continue;
      }

      const player = players[Math.floor(Math.random() * players.length)];
      const generator =
        requested === "dice" || requested === "yut"
          ? requested
          : (Math.random() < 0.5 ? "dice" : "yut");

      try {
        await runDemoTurn(player, generator);
      } catch (_) {
        // 데모는 다음 턴으로 계속 진행한다.
      }
      await delay(650);
    }
  }

  const api = {
    MIN_COLUMNS,
    MIN_ROWS,
    MAX_COLUMNS,
    MAX_ROWS,
    MAX_PLAYERS,
    registerPlayer,
    removePlayer,
    enqueueThrowEvent,
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

  function roomCellLabel(cell) {
    if (!cell) return "";
    if (cell.index === 0 || cell.type === "START") return "START";
    if (cell.label) return cell.label;

    const action = cell.action;
    if (!action || typeof action !== "object") return cell.instructionId || "";

    if (action.type === "move") {
      const resolved = Number(action.resolvedSteps);
      const fixed = Number(action.steps?.value);
      const steps = Number.isFinite(resolved) ? resolved : fixed;
      if (Number.isFinite(steps)) {
        return (action.direction === "backward" ? "-" : "+") + Math.abs(steps);
      }
    }
    if (action.type === "skipThrow") return "다음 던지기 스킵";
    if (action.type === "extraThrow") return "한 번 더";
    return cell.instructionId || "";
  }

  async function loadRoomBoard(roomId) {
    const response = await fetch("/api/board/rooms/" + encodeURIComponent(roomId), {
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });

    const text = await response.text();
    let snapshot = {};
    if (text) {
      try { snapshot = JSON.parse(text); }
      catch { snapshot = { error: text }; }
    }
    if (!response.ok) {
      throw new Error(snapshot.error || (response.status + " " + response.statusText));
    }

    const configuredStyle = snapshot.config?.board?.layoutStyle || "rounded";
    const expectedStyle = "rounded";
    if (configuredStyle !== expectedStyle) {
      const target = configuredStyle === "rect" ? "rect.html" : "index.html";
      const url = new URL(target, window.location.href);
      url.searchParams.set("roomId", roomId);
      if (ROOM_PREVIEW_MODE) url.searchParams.set("preview", "1");
      if (ROOM_BOARD_SOURCE === "committed") url.searchParams.set("board", "committed");
      window.location.replace(url.toString());
      return null;
    }

    let runtime = null;
    if (!ROOM_PREVIEW_MODE && snapshot.status === "READY") {
      try {
        const runtimeResponse = await fetch(
          "/api/board/rooms/" + encodeURIComponent(roomId) + "/runtime",
          {
            cache: "no-store",
            headers: { "Accept": "application/json" }
          }
        );
        if (runtimeResponse.ok) runtime = await runtimeResponse.json();
      } catch (_) {
        runtime = null;
      }
    }

    const source = runtime?.board || (
      ROOM_BOARD_SOURCE === "committed"
        ? (snapshot.committedBoard || snapshot.preview)
        : snapshot.preview
    );

    if (!source) throw new Error("room board preview is missing");

    const columns = Number(snapshot.config?.board?.columns);
    const rows = Number(snapshot.config?.board?.rows);
    if (!Number.isInteger(columns) || !Number.isInteger(rows)) {
      throw new Error("room board dimensions are invalid");
    }

    board.columns = clamp(columns, MIN_COLUMNS, MAX_COLUMNS);
    board.rows = clamp(rows, MIN_ROWS, MAX_ROWS);
    board.cellCount = perimeterCellCount(board.columns, board.rows);

    const cells = {};
    for (const cell of source.cells || []) {
      const index = Number(cell.index);
      if (!Number.isInteger(index) || index < 0 || index >= board.cellCount) continue;
      cells[index] = {
        label: roomCellLabel(cell),
        command: roomCellLabel(cell),
        kind: index === 0 ? "start" : (cell.type === "NORMAL" ? "normal" : "instruction")
      };
    }

    state.phasePlan = [{
      id: "room-preview",
      minTotalLaps: 0,
      label: "ROOM PREVIEW",
      description: snapshot.config?.name || "Room",
      cells
    }];
    state.currentPhaseId = "room-preview";

    buildBoard();
    renderGlobalState();

    const runtimePlayers = new Map(
      (runtime?.players || []).map((player) => [String(player.soopId), player])
    );

    for (const [index, player] of (snapshot.config?.players || []).entries()) {
      const runtimePlayer = runtimePlayers.get(String(player.soopId));
      registerPlayer({
        id: player.soopId || ("preview-player-" + index),
        name: player.displayName || player.soopId || ("참가자 " + (index + 1)),
        shortLabel: String(player.displayName || player.soopId || (index + 1)).slice(0, 1),
        position: ROOM_PREVIEW_MODE ? 0 : (runtimePlayer?.position ?? 0)
      });
    }

    setEventMessage(
      (snapshot.config?.name || "룸") + " · " +
      board.columns + "×" + board.rows +
      " · 외곽 " + board.cellCount + "칸"
    );
    return snapshot;
  }

  function cellFromRuntimeState(cell) {
    return {
      label: roomCellLabel(cell),
      command: roomCellLabel(cell),
      kind: cell?.index === 0
        ? "start"
        : (cell?.type === "NORMAL" ? "normal" : "instruction")
    };
  }

  function applyCellUpdate(update) {
    const cell = update?.current;
    const index = Number(update?.cellIndex);
    if (!cell || !Number.isInteger(index) || index < 0 || index >= board.cellCount) return;

    const phase = currentPhase();
    if (!phase.cells) phase.cells = {};
    phase.cells[index] = cellFromRuntimeState(cell);

    const element = cellElements.get(index);
    if (!element) return;
    const definition = cellDefinition(index);
    element.dataset.kind = definition.kind;
    const label = element.querySelector(".cell-label");
    if (label) label.textContent = definition.command || definition.label;
  }

  async function playResolvedTurn(turn) {
    if (!turn || turn.type !== "board.turn" || String(turn.roomId) !== ROOM_ID) return;

    const playerId = String(turn.playerId || "");
    const player = state.players.get(playerId);
    if (!player) return;

    if (turn.openingThrowSkipped) {
      setEventMessage((turn.playerName || player.name) + " · 다음 던지기 스킵");
      return;
    }

    for (const resolution of turn.throwResolutions || []) {
      const event = {
        eventId: turn.eventId + "-" + resolution.index,
        playerId,
        generator: resolution.generator,
        resolvedSteps: Number(resolution.steps),
        appliedMultiplier: Number(resolution.appliedMultiplier) || 1,
        bonusThrow: Boolean(resolution.nextThrowScheduled)
      };

      if (resolution.generator === "dice") {
        event.dice = {
          values: resolution.dice?.values || [],
          total: resolution.dice?.total,
          isDouble: Boolean(resolution.dice?.isDouble)
        };
      } else {
        event.yut = {
          name: resolution.yut?.name,
          steps: resolution.yut?.steps,
          faces: resolution.yut?.faces || []
        };
      }

      await enqueueThrowEvent(event, { source: "server" });

      const landings = Array.isArray(resolution.landingChain) && resolution.landingChain.length
        ? resolution.landingChain
        : (resolution.landing ? [resolution.landing] : []);

      for (const landing of landings) {
        const actionMoveSteps = Number(landing?.actionMoveSteps);
        if (Number.isInteger(actionMoveSteps) && actionMoveSteps !== 0) {
          await movePlayerBy(playerId, actionMoveSteps, { source: "cell-action" });
        }
      }

      for (const update of resolution.cellUpdates || []) {
        applyCellUpdate(update);
      }
    }

    if (player.position !== Number(turn.endPosition)) {
      player.position = normalizeCell(turn.endPosition);
      renderPlayers();
    }
  }

  async function syncRoomRuntimeState() {
    if (!ROOM_ID || ROOM_PREVIEW_MODE) return 0;

    const response = await fetch(
      "/api/board/rooms/" + encodeURIComponent(ROOM_ID) + "/runtime",
      {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      }
    );
    if (!response.ok) return 0;

    const runtime = await response.json();

    for (const cell of runtime.board?.cells || []) {
      applyCellUpdate({ cellIndex: cell.index, current: cell });
    }

    for (const runtimePlayer of runtime.players || []) {
      const player = state.players.get(String(runtimePlayer.soopId));
      if (!player) continue;
      player.position = normalizeCell(runtimePlayer.position);
      player.laps = Number(runtimePlayer.laps) || 0;
    }
    renderPlayers();

    return Number(runtime.sequence) || 0;
  }

  function connectRoomWebSocket() {
    if (!ROOM_ID || !ROOM_WS_URL || ROOM_PREVIEW_MODE) return;

    let socket;
    let retryTimer = 0;
    let retryAttempt = 0;
    let closed = false;
    let lastSequence = 0;

    const connect = () => {
      if (closed) return;
      try {
        socket = new WebSocket(ROOM_WS_URL);
      } catch (_) {
        schedule();
        return;
      }

      socket.addEventListener("open", () => {
        retryAttempt = 0;
        syncRoomRuntimeState()
          .then((sequence) => {
            if (sequence > lastSequence) lastSequence = sequence;
          })
          .catch(() => {});
      });

      socket.addEventListener("message", (message) => {
        let payload;
        try {
          payload = JSON.parse(message.data);
        } catch (_) {
          return;
        }
        if (payload?.type !== "board.turn") return;
        if (String(payload.roomId) !== ROOM_ID) return;

        const sequence = Number(payload.sequence) || 0;
        if (sequence && sequence <= lastSequence) return;
        if (sequence) lastSequence = sequence;

        roomTurnPlaybackQueue = roomTurnPlaybackQueue
          .catch(() => undefined)
          .then(() => playResolvedTurn(payload))
          .catch((error) => {
            console.error("[board-room] turn playback failed", error);
          });
      });

      socket.addEventListener("close", schedule);
      socket.addEventListener("error", () => {});
    };

    const schedule = () => {
      if (closed || retryTimer) return;
      const delayMs = Math.min(5000, 600 * (2 ** Math.min(retryAttempt, 4)));
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        connect();
      }, delayMs);
    };

    window.addEventListener("beforeunload", () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    }, { once: true });

    connect();
  }

  async function initialize() {
    if (ROOM_ID) {
      try {
        const loaded = await loadRoomBoard(ROOM_ID);
        if (!loaded) return;
        connectRoomWebSocket();
      } catch (error) {
        buildBoard();
        renderGlobalState();
        setEventMessage("룸 프리뷰 로드 실패: " + error.message);
        console.error("[board-room]", error);
      }
    } else {
      buildBoard();
      renderGlobalState();
    }

    if (window.ResizeObserver && refs.boardStage) {
      new ResizeObserver(scheduleLayout).observe(refs.boardStage);
    } else {
      window.addEventListener("resize", scheduleLayout);
    }

    if (DEMO_MODE) {
      startDemo();
    } else if (!ROOM_ID) {
      setEventMessage(
        board.columns + "×" + board.rows +
        " · 외곽 " + board.cellCount +
        "칸 방송 오버레이 준비 완료"
      );
    }
  }

  initialize();
})();
