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

  const params = new URLSearchParams(window.location.search);
  const DEMO_MODE = params.get("demo") === "1";
  const INSTANT_MOVEMENT_MODE =
    params.get("motion") === "instant" ||
    /(?:^|\/)(?:rect-)?instant\.html$/i.test(window.location.pathname);
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
    eventMessage: document.getElementById("eventMessage"),
    playerLayer: null
  };

  const cellElements = new Map();
  const playerZoneElements = new Map();
  const playerMarkerElements = new Map();
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
  const instructionFlashTimers = new Map();
  // 이동 중인 말은 보드 셀 스프링과 분리해 한 칸 단위 고정 시간 애니메이션으로 처리한다.
  const directTokenAnimations = new Set();
  // transform이 적용된 각 board-cell은 독립 stacking context이므로,
  // 이동 중인 토큰이 다른 셀 뒤로 숨지 않도록 현재 부모 셀을 임시로 최상위에 둔다.
  const movingTokenLayerStates = new Map();

  const TOKEN_BASE_SIZE = 26;
  const INSTRUCTION_ZONE_RATIO = 0.50;
  const PLAYER_ZONE_RATIO = 0.50;
  const OCCUPIED_HORIZONTAL_INSTRUCTION_ZONE_RATIO = 0.50;
  const OCCUPIED_HORIZONTAL_PLAYER_ZONE_RATIO = 0.50;
  const PLAYER_EDGE_PADDING = 5;
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
      label: configured.label ?? (index === 0 ? "START" : ""),
      command: configured.command || null,
      kind: configured.kind || (index === 0 ? "start" : "normal"),
      instructionType: configured.instructionType || (index === 0 ? "start" : "normal"),
      randomCell: Boolean(configured.randomCell)
    };
  }

  function setEventMessage(message) {
    if (refs.eventMessage) refs.eventMessage.textContent = message;
  }

  function renderGlobalState() {
    if (!refs.boardStage) return;

    refs.boardStage.dataset.layoutEngine = "reserve-first-loop-v4";
    refs.boardStage.dataset.movementMode =
      INSTANT_MOVEMENT_MODE ? "instant-marker-overlay-v8" : "marker-overlay-v8";
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

  function ensurePlayerLayer() {
    if (!refs.boardStage) return null;
    if (refs.playerLayer && refs.playerLayer.isConnected) {
      return refs.playerLayer;
    }

    const existing = refs.boardStage.querySelector(".player-token-layer");
    if (existing) {
      refs.playerLayer = existing;
      return existing;
    }

    const layer = document.createElement("div");
    layer.className = "player-token-layer";
    layer.setAttribute("aria-hidden", "true");
    refs.boardStage.append(layer);
    refs.playerLayer = layer;
    return layer;
  }

  function buildBoard() {
    if (!refs.boardGrid) return;

    const playerLayer = ensurePlayerLayer();

    if (refs.boardStage) {
      refs.boardStage.dataset.layoutReady = "false";
    }

    refs.boardGrid.innerHTML = "";
    cellElements.clear();
    playerZoneElements.clear();
    playerMarkerElements.clear();
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
      cell.dataset.instructionType = definition.instructionType;
      cell.dataset.randomCell = String(definition.randomCell);
      cell.dataset.occupied = "false";
      cell.dataset.playerState = "normal";

      const label = document.createElement("span");
      label.className = "cell-label";
      label.textContent = definition.command || definition.label;

      const instructionZone = document.createElement("span");
      instructionZone.className = "cell-instruction-zone";
      instructionZone.append(label);

      const playerZone = document.createElement("span");
      playerZone.className = "cell-player-zone";
      playerZone.dataset.cellIndex = String(index);
      playerZone.dataset.count = "0";
      playerZone.setAttribute("aria-hidden", "true");

      cell.append(instructionZone, playerZone);
      refs.boardGrid.append(cell);
      cellElements.set(index, cell);
      playerZoneElements.set(index, playerZone);
    }

    if (playerLayer) playerLayer.replaceChildren();
    playerTokenElements.clear();
    playerMarkerElements.clear();
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

    for (const [playerId, state] of tokenMotionStates.entries()) {
      if (!state.element.isConnected) continue;
      if (directTokenAnimations.has(String(playerId))) continue;
      moving = advanceMotionState(state, deltaTime) || moving;
    }

    // 셀 spring이 움직이는 동안에도 marker의 최신 화면 좌표를 따라간다.
    syncPlayerOverlayPositions();

    if (moving) {
      motionFrame = window.requestAnimationFrame(animateMotion);
    } else {
      lastMotionTime = 0;
    }
  }

  function snapAllMotionToTargetsInstant() {
    if (motionFrame) {
      window.cancelAnimationFrame(motionFrame);
      motionFrame = 0;
    }
    lastMotionTime = 0;

    for (const motion of cellMotionStates.values()) {
      if (!motion.element.isConnected) continue;
      motion.x = motion.targetX;
      motion.y = motion.targetY;
      motion.scale = motion.targetScale;
      motion.vx = 0;
      motion.vy = 0;
      motion.vs = 0;
      applyMotionTransform(motion);
    }

    for (const motion of tokenMotionStates.values()) {
      if (!motion.element.isConnected) continue;
      motion.x = motion.targetX;
      motion.y = motion.targetY;
      motion.scale = motion.targetScale;
      motion.vx = 0;
      motion.vy = 0;
      motion.vs = 0;
      applyMotionTransform(motion);
    }

    syncPlayerOverlayPositions(true);
  }

  function scheduleMotion() {
    if (INSTANT_MOVEMENT_MODE) {
      snapAllMotionToTargetsInstant();
      return;
    }

    if (motionFrame) return;

    let moving = false;
    for (const state of cellMotionStates.values()) {
      if (stateNeedsMotion(state)) {
        moving = true;
        break;
      }
    }

    if (!moving) {
      for (const [playerId, state] of tokenMotionStates.entries()) {
        if (directTokenAnimations.has(String(playerId))) continue;
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
    const instructionRatio = 0.50;

    if (edge === "top") {
      minY += geometry.height * instructionRatio;
    } else if (edge === "bottom") {
      maxY -= geometry.height * instructionRatio;
    } else if (edge === "left") {
      minX += geometry.width * instructionRatio;
    } else {
      maxX -= geometry.width * instructionRatio;
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
    const labelFontSize = clamp(baseTypography * 0.115, 7.5, 15.5);
    const cellRadius = clamp(Math.min(baseWidth, baseHeight) * 0.09, 2, 10);
    const scale = geometry.width / Math.max(0.01, baseWidth);
    const targetX = geometry.centerX - (baseWidth * 0.5);
    const targetY = geometry.centerY - (baseHeight * 0.5);
    const snap = refs.boardStage.dataset.layoutReady !== "true";

    const baseWidthText = baseWidth.toFixed(3) + "px";
    const baseHeightText = baseHeight.toFixed(3) + "px";
    if (cell.style.width !== baseWidthText) cell.style.width = baseWidthText;
    if (cell.style.height !== baseHeightText) cell.style.height = baseHeightText;

    cell.style.setProperty("--cell-label-font", labelFontSize.toFixed(3) + "px");
    cell.style.setProperty("--cell-radius", cellRadius.toFixed(3) + "px");
    cell.style.setProperty(
      "--player-token-local-size",
      clamp(Math.min(baseWidth, baseHeight) * 0.46, 9, 31).toFixed(3) + "px"
    );
    // player zone은 셀과 함께 scale되므로 화면 기준 5px 여백을 유지하려면
    // local padding은 현재 셀 scale의 역수로 보정한다.
    cell.style.setProperty(
      "--player-edge-padding-local",
      (PLAYER_EDGE_PADDING / Math.max(0.01, scale)).toFixed(3) + "px"
    );
    cell.style.zIndex = String(Math.round(weight * 100) + (occupied ? 200 : 0));

    cell.dataset.occupied = String(occupied);
    cell.dataset.playerState = occupied
      ? "occupied"
      : (weight > 1.0001 ? "adjacent" : "normal");
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
    cell.style.setProperty(
      "--occupied-horizontal-player-zone-ratio",
      (OCCUPIED_HORIZONTAL_PLAYER_ZONE_RATIO * 100).toFixed(2) + "%"
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
    refs.boardGrid.dataset.instructionZoneRatio = INSTRUCTION_ZONE_RATIO.toFixed(2);
    refs.boardGrid.dataset.playerZoneRatio = PLAYER_ZONE_RATIO.toFixed(2);
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

    layoutFrame = window.requestAnimationFrame(() => {
      try {
        layoutNow();
      } catch (error) {
        layoutFrame = 0;
        console.error("board layout failed", error);
      }
    });
  }

  function waitForRenderFrame(timeoutMs = 120) {
    return new Promise((resolve) => {
      let settled = false;
      let frameId = 0;
      let timeoutId = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        if (timeoutId) window.clearTimeout(timeoutId);
        resolve();
      };

      frameId = window.requestAnimationFrame(finish);
      timeoutId = window.setTimeout(finish, timeoutMs);
    });
  }

  function snapTokenMotionToLatestTarget(playerId) {
    const motion = tokenMotionStates.get(String(playerId));
    if (!motion) return;

    motion.x = motion.targetX;
    motion.y = motion.targetY;
    motion.scale = motion.targetScale;
    motion.vx = 0;
    motion.vy = 0;
    motion.vs = 0;
    applyMotionTransform(motion);
  }

  function animatePlayerOneCell(playerId, durationMs = STEP_DELAY_MS) {
    const id = String(playerId);
    const motion = tokenMotionStates.get(id);

    if (!motion || !motion.element.isConnected) {
      return delay(durationMs);
    }

    const startX = motion.x;
    const startY = motion.y;
    const startScale = motion.scale;
    motion.vx = 0;
    motion.vy = 0;
    motion.vs = 0;
    directTokenAnimations.add(id);

    return new Promise((resolve) => {
      let settled = false;
      let startedAt = 0;
      let frameId = 0;
      let timeoutId = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        if (timeoutId) window.clearTimeout(timeoutId);

        snapTokenMotionToLatestTarget(id);
        directTokenAnimations.delete(id);
        scheduleMotion();
        resolve();
      };

      const frame = (timestamp) => {
        if (settled) return;
        if (!startedAt) startedAt = timestamp;

        const progress = clamp(
          (timestamp - startedAt) / Math.max(1, durationMs),
          0,
          1
        );
        const eased = 1 - Math.pow(1 - progress, 3);

        // 다른 플레이어 때문에 보드 목표가 변해도 매 프레임 최신 목적지를 사용한다.
        motion.x = startX + ((motion.targetX - startX) * eased);
        motion.y = startY + ((motion.targetY - startY) * eased);
        motion.scale = startScale + ((motion.targetScale - startScale) * eased);
        applyMotionTransform(motion);

        if (progress >= 1) {
          finish();
          return;
        }
        frameId = window.requestAnimationFrame(frame);
      };

      frameId = window.requestAnimationFrame(frame);
      // rAF가 정지/지연돼도 이동 큐가 영구 대기하지 않는다.
      timeoutId = window.setTimeout(finish, durationMs + 180);
    });
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

    const overlay = document.createElement("span");
    overlay.className = "player-token-overlay";

    const bubble = document.createElement("span");
    bubble.className = "player-result-bubble";
    bubble.dataset.visible = "false";

    const effectBadges = document.createElement("span");
    effectBadges.className = "player-effect-badges";
    effectBadges.dataset.visible = "false";

    overlay.append(bubble, effectBadges);
    token.append(label, overlay);
    renderDemoEffectBadges(player.id);
    return token;
  }

  function createPlayerMarker(player) {
    const marker = document.createElement("span");
    marker.className = "player-token-marker";
    marker.dataset.playerId = player.id;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }

  function updatePlayerToken(token, player) {
    token.title = player.name;
    const label = token.querySelector(".player-token-label");
    if (label) label.textContent = player.shortLabel;
    renderDemoEffectBadges(player.id);
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

  function playerZoneForCell(cellIndex) {
    return playerZoneElements.get(normalizeCell(cellIndex)) || null;
  }

  function updatePlayerZoneMetadata(occupancy = occupancyByCell()) {
    for (let index = 0; index < board.cellCount; index += 1) {
      const zone = playerZoneElements.get(index);
      if (!zone) continue;
      const players = occupancy.get(index) || [];
      zone.dataset.count = String(players.length);
      zone.dataset.overflow = String(players.length >= 3);
    }
  }

  function moveTokenElementToCell(playerId, cellIndex) {
    const id = String(playerId);
    const marker = playerMarkerElements.get(id);
    const zone = playerZoneForCell(cellIndex);
    if (!marker || !zone) return false;

    if (marker.parentElement !== zone) {
      zone.append(marker);
    }
    marker.dataset.cellIndex = String(normalizeCell(cellIndex));
    return true;
  }

  function syncPlayerTokenParents(occupancy = occupancyByCell()) {
    // V8: 논리/레이아웃 위치는 투명 marker가 담당하고,
    // 실제 player-token은 board-stage의 독립 overlay에 계속 남는다.
    updatePlayerZoneMetadata(occupancy);

    for (const [cellIndex, players] of occupancy.entries()) {
      const zone = playerZoneElements.get(cellIndex);
      if (!zone) continue;

      const visiblePlayers = players.slice(0, MAX_PLAYERS);
      visiblePlayers.forEach((player, playerIndex) => {
        const id = String(player.id);
        const marker = playerMarkerElements.get(id);
        const token = playerTokenElements.get(id);
        if (!marker || !token) return;

        if (marker.parentElement !== zone) zone.append(marker);

        for (const element of [marker, token]) {
          element.dataset.cellIndex = String(cellIndex);
          element.dataset.stackIndex = String(playerIndex);
          element.dataset.stackCount = String(visiblePlayers.length);
          element.dataset.stacked = String(visiblePlayers.length > 1);
          element.dataset.cellOverflow = String(visiblePlayers.length >= 3);
        }

        const edge = cellElements.get(cellIndex)?.dataset.instructionEdge || "top";
        token.dataset.bubbleSide =
          edge === "top" ? "down" :
          edge === "bottom" ? "up" :
          edge === "left" ? "right" : "left";
      });
    }
  }

  function setOverlayTokenViewportCenter(playerId, centerX, centerY) {
    const id = String(playerId);
    const token = playerTokenElements.get(id);
    if (!token || !token.isConnected || !refs.boardStage) return false;

    const stageRect = refs.boardStage.getBoundingClientRect();
    const x = centerX - stageRect.left - (TOKEN_BASE_SIZE * 0.5);
    const y = centerY - stageRect.top - (TOKEN_BASE_SIZE * 0.5);

    token.style.transform =
      "translate3d(" + x.toFixed(3) + "px," +
      y.toFixed(3) + "px,0)";
    return true;
  }

  function syncPlayerOverlayPosition(playerId, force = false) {
    const id = String(playerId);
    if (!force && directTokenAnimations.has(id)) return false;

    const marker = playerMarkerElements.get(id);
    if (!marker || !marker.isConnected) return false;

    const markerRect = marker.getBoundingClientRect();
    if (markerRect.width <= 0 || markerRect.height <= 0) return false;

    return setOverlayTokenViewportCenter(
      id,
      markerRect.left + (markerRect.width * 0.5),
      markerRect.top + (markerRect.height * 0.5)
    );
  }

  function syncPlayerOverlayPositions(force = false) {
    for (const playerId of playerTokenElements.keys()) {
      syncPlayerOverlayPosition(playerId, force);
    }
  }

  function ensurePlayerTokens() {
    const layer = ensurePlayerLayer();
    const activeIds = new Set();

    for (const player of state.players.values()) {
      const id = String(player.id);
      activeIds.add(id);

      let token = playerTokenElements.get(id);
      if (!token) {
        token = createPlayerToken(player);
        playerTokenElements.set(id, token);
      } else {
        updatePlayerToken(token, player);
      }

      if (layer && token.parentElement !== layer) {
        layer.append(token);
      }

      let marker = playerMarkerElements.get(id);
      if (!marker) {
        marker = createPlayerMarker(player);
        playerMarkerElements.set(id, marker);
      }

      const zone = playerZoneForCell(player.position);
      if (zone && marker.parentElement !== zone) {
        zone.append(marker);
      }

      token.dataset.cellIndex = String(player.position);
      marker.dataset.cellIndex = String(player.position);
      renderDemoEffectBadges(id);
    }

    for (const [playerId, token] of playerTokenElements.entries()) {
      if (activeIds.has(playerId)) continue;
      token.remove();
      playerTokenElements.delete(playerId);
      tokenMotionStates.delete(playerId);
      directTokenAnimations.delete(String(playerId));
    }

    for (const [playerId, marker] of playerMarkerElements.entries()) {
      if (activeIds.has(playerId)) continue;
      marker.remove();
      playerMarkerElements.delete(playerId);
    }

    syncPlayerTokenParents();
    syncPlayerOverlayPositions();
  }

  function tokenLayout(count, tokenSize, geometry, allowOverflow = false) {  function tokenLayout(count, tokenSize, geometry, allowOverflow = false) {
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
    const spacing = allowOverflow
      ? preferredSpacing
      : clamp(
          Math.min(preferredSpacing, fitSpacing),
          tokenSize * 0.52,
          preferredSpacing
        );

    // 1~2명은 셀 내부에 유지한다.
    // 3명 이상부터는 두 번째 줄이 보드 안쪽 방향으로 셀 밖까지 확장될 수 있다.
    const rowDepth = tokenSize * 0.72;
    const slots = [];

    rows.forEach((rowCount, rowIndex) => {
      for (let index = 0; index < rowCount; index += 1) {
        slots.push({
          tangent: (index - ((rowCount - 1) * 0.5)) * spacing,
          depth: (allowOverflow ? 1 : -1) * (rowIndex * rowDepth)
        });
      }
    });

    return { tokenSize, slots };
  }

  function layoutPlayerTokens(placements, occupancy) {
    // V8: cell-player-zone에는 투명 marker만 배치한다.
    // 실제 말은 board-stage overlay에서 marker의 화면 절대좌표를 추적한다.
    ensurePlayerTokens();
    syncPlayerTokenParents(occupancy);
    syncPlayerOverlayPositions();
  }

  function renderPlayers() {  function renderPlayers() {
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
      "보드 크기 변경 " + board.columns + "×" + board.rows + " · 외곽 " + board.cellCount + "칸"
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
          "전체 누적 " + state.totalLaps + "바퀴, " + next.label + "로 판 전환"
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

  /*
   * PRESERVED MOVEMENT V34
   * 2026-09-25-34에서 사용하던 이동 구현을 회귀 비교용으로 그대로 보존한다.
   * 현재 런타임에서는 호출하지 않는다.
   */
  async function movePlayerByPreservedV34(playerId, steps, meta = {}) {
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

      // 보드 Dock 재배치는 일반 rAF 레이아웃으로 맡긴다.
      // 예약된 레이아웃 프레임이 먼저 실행되도록 한 프레임을 넘긴 뒤,
      // 말 자체는 셀 스프링과 독립된 고정 시간 애니메이션으로 정확히 한 칸 이동한다.
      renderPlayers();
      await waitForRenderFrame();

      const token = playerTokenElements.get(player.id);
      if (token?.dataset.cellIndex !== String(player.position)) {
        // 레이아웃 프레임이 일시 실패한 경우에만 한 번 재예약한다.
        scheduleLayout();
        await waitForRenderFrame();
      }

      await animatePlayerOneCell(player.id, STEP_DELAY_MS);
    }

    // 최종 논리 위치의 최신 목표 좌표에 정확히 맞춘다.
    snapTokenMotionToLatestTarget(player.id);

    if (!meta.suppressDestinationEvent) {
      const command = destinationCommand(player.position);
      const source = meta.source ? " (" + meta.source + ")" : "";

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
    }

    return { ...player };
  }

  function captureTokenVisualState(playerId) {
    const id = String(playerId);
    const motion = tokenMotionStates.get(id);
    if (!motion) return null;

    motion.vx = 0;
    motion.vy = 0;
    motion.vs = 0;

    return {
      element: motion.element,
      x: motion.x,
      y: motion.y,
      scale: motion.scale
    };
  }

  function restoreTokenVisualState(playerId, visual) {
    if (!visual) return;
    const motion = tokenMotionStates.get(String(playerId));
    if (!motion || !motion.element.isConnected) return;

    motion.x = visual.x;
    motion.y = visual.y;
    motion.scale = visual.scale;
    motion.vx = 0;
    motion.vy = 0;
    motion.vs = 0;
    applyMotionTransform(motion);
  }

  function tokenTargetReady(playerId, expectedCell) {
    const id = String(playerId);
    const token = playerTokenElements.get(id);
    const motion = tokenMotionStates.get(id);

    return Boolean(
      token &&
      motion &&
      motion.element.isConnected &&
      token.dataset.cellIndex === String(expectedCell) &&
      Number.isFinite(motion.targetX) &&
      Number.isFinite(motion.targetY) &&
      Number.isFinite(motion.targetScale)
    );
  }

  function waitForTokenTarget(playerId, expectedCell, visual, timeoutMs = 140) {
    const id = String(playerId);

    return new Promise((resolve) => {
      let settled = false;
      let frameId = 0;
      let timeoutId = 0;

      const finish = (ready) => {
        if (settled) return;
        settled = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        if (timeoutId) window.clearTimeout(timeoutId);

        const motion = tokenMotionStates.get(id);
        if (
          ready &&
          visual &&
          motion &&
          motion.element !== visual.element
        ) {
          // START/phase 전환으로 토큰 DOM이 재생성돼도 이전 화면 위치에서 이어서 이동한다.
          restoreTokenVisualState(id, visual);
        }
        resolve(Boolean(ready));
      };

      const check = () => {
        if (settled) return;
        if (tokenTargetReady(id, expectedCell)) {
          finish(true);
          return;
        }
        frameId = window.requestAnimationFrame(check);
      };

      // 정상 경로는 예약된 layout rAF 한 번으로 목적지가 준비된다.
      scheduleLayout();
      frameId = window.requestAnimationFrame(check);

      // rAF가 지연되거나 한 번 실패한 경우에만 기존 layoutNow를 동기 fallback으로 1회 사용한다.
      timeoutId = window.setTimeout(() => {
        if (settled) return;
        if (!tokenTargetReady(id, expectedCell)) {
          try {
            layoutNow();
          } catch (error) {
            console.error("movement target layout failed", error);
          }
        }
        finish(tokenTargetReady(id, expectedCell));
      }, timeoutMs);
    });
  }

  function animateTokenStepV2(playerId, visual, durationMs = STEP_DELAY_MS) {
    const id = String(playerId);
    const start = visual || captureTokenVisualState(id);

    return new Promise((resolve) => {
      let settled = false;
      let startedAt = 0;
      let frameId = 0;
      let timeoutId = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        if (timeoutId) window.clearTimeout(timeoutId);

        snapTokenMotionToLatestTarget(id);
        directTokenAnimations.delete(id);
        scheduleMotion();
        resolve();
      };

      if (!start) {
        timeoutId = window.setTimeout(finish, durationMs);
        return;
      }

      const frame = (timestamp) => {
        if (settled) return;
        if (!startedAt) startedAt = timestamp;

        const motion = tokenMotionStates.get(id);
        if (!motion || !motion.element.isConnected) {
          frameId = window.requestAnimationFrame(frame);
          return;
        }

        const progress = clamp(
          (timestamp - startedAt) / Math.max(1, durationMs),
          0,
          1
        );
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - (Math.pow(-2 * progress + 2, 3) / 2);

        // 목적지 보드 셀이 Dock 스프링으로 움직여도 최신 목표를 따라가되,
        // 출발 좌표는 스텝 시작 순간에 고정해 한 칸 이동량이 축소되지 않게 한다.
        motion.x = start.x + ((motion.targetX - start.x) * eased);
        motion.y = start.y + ((motion.targetY - start.y) * eased);
        motion.scale = start.scale + ((motion.targetScale - start.scale) * eased);
        motion.vx = 0;
        motion.vy = 0;
        motion.vs = 0;
        applyMotionTransform(motion);

        if (progress >= 1) {
          finish();
          return;
        }
        frameId = window.requestAnimationFrame(frame);
      };

      frameId = window.requestAnimationFrame(frame);
      // 탭/브라우저 rAF 정지 상황에서도 큐가 영구 대기하지 않는다.
      timeoutId = window.setTimeout(finish, durationMs + 160);
    });
  }

  /*
   * PRESERVED MOVEMENT V35
   * 2026-09-25-35 active 이동 구현. 회귀 비교용으로 보존하며 런타임에서는 호출하지 않는다.
   */
  async function movePlayerByPreservedV35(playerId, steps, meta = {}) {
    const player = state.players.get(String(playerId));
    if (!player) throw new Error("unknown player: " + playerId);

    const signedSteps = Number.parseInt(steps, 10) || 0;
    const direction = signedSteps < 0 ? -1 : 1;
    const distance = Math.abs(signedSteps);
    if (!distance) return { ...player };

    for (let moved = 0; moved < distance; moved += 1) {
      const id = String(player.id);

      // 가장 먼저 말을 공유 스프링에서 제외한다.
      // 레이아웃 목적지를 계산하는 한 프레임 동안 말이 미리 움직이는 현상을 차단한다.
      directTokenAnimations.add(id);
      const visualStart = captureTokenVisualState(id);

      const previous = player.position;
      player.position = normalizeCell(player.position + direction);

      if (
        direction > 0 &&
        previous === board.cellCount - 1 &&
        player.position === 0
      ) {
        player.laps += 1;
        state.totalLaps += 1;
        evaluatePhase();
      }

      ensurePlayerTokens();
      renderGlobalState();
      scheduleLayout();

      const targetReady = await waitForTokenTarget(
        id,
        player.position,
        visualStart
      );

      if (!targetReady) {
        // 목적지 계산 실패는 해당 스텝을 무한 대기시키지 않는다.
        // 논리 위치는 유지하고 다음 일반 레이아웃에서 복구할 수 있도록 현재 프레임만 보정한다.
        console.error(
          "movement target unavailable",
          { playerId: id, position: player.position }
        );
      }

      await animateTokenStepV2(id, visualStart, STEP_DELAY_MS);
    }

    snapTokenMotionToLatestTarget(player.id);

    if (!meta.suppressDestinationEvent) {
      const command = destinationCommand(player.position);
      const source = meta.source ? " (" + meta.source + ")" : "";

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
    }

    return { ...player };
  }

  function releaseDirectTokenLock(playerId) {
    const id = String(playerId);
    directTokenAnimations.delete(id);
    scheduleMotion();
  }

  async function acquireMovementTargetV3(playerId, expectedCell, visualStart) {
    const id = String(playerId);

    // 1차: 정상 비동기 layout rAF.
    scheduleLayout();
    await waitForRenderFrame();
    if (tokenTargetReady(id, expectedCell)) {
      const motion = tokenMotionStates.get(id);
      if (visualStart && motion && motion.element !== visualStart.element) {
        restoreTokenVisualState(id, visualStart);
      }
      return true;
    }

    // 2차: 같은 기존 layoutNow를 동기 실행. 레이아웃 공식 자체는 변경하지 않는다.
    try {
      layoutNow();
    } catch (error) {
      console.error("movement target layout retry failed", error);
    }
    await waitForRenderFrame();
    if (tokenTargetReady(id, expectedCell)) {
      const motion = tokenMotionStates.get(id);
      if (visualStart && motion && motion.element !== visualStart.element) {
        restoreTokenVisualState(id, visualStart);
      }
      return true;
    }

    // 3차: 마지막 bounded rAF 재시도. 여기서도 실패하면 stale target으로 진행하지 않는다.
    scheduleLayout();
    await waitForRenderFrame();
    if (tokenTargetReady(id, expectedCell)) {
      const motion = tokenMotionStates.get(id);
      if (visualStart && motion && motion.element !== visualStart.element) {
        restoreTokenVisualState(id, visualStart);
      }
      return true;
    }

    return false;
  }

  function animateTokenStepV3(playerId, visualStart, durationMs = STEP_DELAY_MS) {
    const id = String(playerId);
    const start = visualStart || captureTokenVisualState(id);

    return new Promise((resolve) => {
      let settled = false;
      let startedAt = 0;
      let frameId = 0;
      let timeoutId = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        if (timeoutId) window.clearTimeout(timeoutId);

        snapTokenMotionToLatestTarget(id);
        releaseDirectTokenLock(id);
        resolve();
      };

      if (!start || !tokenTargetReady(id, state.players.get(id)?.position)) {
        finish();
        return;
      }

      const frame = (timestamp) => {
        if (settled) return;
        if (!startedAt) startedAt = timestamp;

        const motion = tokenMotionStates.get(id);
        if (!motion || !motion.element.isConnected) {
          finish();
          return;
        }

        const progress = clamp(
          (timestamp - startedAt) / Math.max(1, durationMs),
          0,
          1
        );
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - (Math.pow(-2 * progress + 2, 3) / 2);

        motion.x = start.x + ((motion.targetX - start.x) * eased);
        motion.y = start.y + ((motion.targetY - start.y) * eased);
        motion.scale = start.scale + ((motion.targetScale - start.scale) * eased);
        motion.vx = 0;
        motion.vy = 0;
        motion.vs = 0;
        applyMotionTransform(motion);

        if (progress >= 1) {
          finish();
          return;
        }
        frameId = window.requestAnimationFrame(frame);
      };

      frameId = window.requestAnimationFrame(frame);
      timeoutId = window.setTimeout(finish, durationMs + 160);
    });
  }

  async function movePlayerStepsCoreV3(playerId, steps) {
    const player = state.players.get(String(playerId));
    if (!player) throw new Error("unknown player: " + playerId);

    const signedSteps = Number.parseInt(steps, 10) || 0;
    const direction = signedSteps < 0 ? -1 : 1;
    const distance = Math.abs(signedSteps);
    if (!distance) return { ...player };

    for (let moved = 0; moved < distance; moved += 1) {
      const id = String(player.id);
      const previous = player.position;
      const next = normalizeCell(previous + direction);

      // 출발 화면 좌표를 먼저 잠그고 캡처한다.
      directTokenAnimations.add(id);
      const visualStart = captureTokenVisualState(id);

      // 목적지 레이아웃 계산을 위해 논리 위치만 임시로 다음 칸에 둔다.
      player.position = next;
      ensurePlayerTokens();
      renderGlobalState();

      const targetReady = await acquireMovementTargetV3(
        id,
        next,
        visualStart
      );

      if (!targetReady) {
        // stale target으로 계속 가지 않는다. 논리 위치를 되돌리고 현재 스텝을 실패 처리한다.
        player.position = previous;
        ensurePlayerTokens();
        renderGlobalState();
        scheduleLayout();
        restoreTokenVisualState(id, visualStart);
        releaseDirectTokenLock(id);
        await waitForRenderFrame();
        throw new Error(
          "movement target unavailable: " + id + " -> " + next
        );
      }

      await animateTokenStepV3(id, visualStart, STEP_DELAY_MS);

      // START 통과에 따른 누적/Phase 갱신은 화면 이동이 끝난 뒤 반영한다.
      if (
        direction > 0 &&
        previous === board.cellCount - 1 &&
        next === 0
      ) {
        player.laps += 1;
        state.totalLaps += 1;
        evaluatePhase();
      }
    }

    snapTokenMotionToLatestTarget(player.id);
    releaseDirectTokenLock(player.id);
    return { ...player };
  }

  function currentVisualTokenTargetV4(playerId, cellIndex) {
    const id = String(playerId);
    const tokenMotion = tokenMotionStates.get(id);
    const cellMotion = cellMotionStates.get(Number(cellIndex));
    const cell = cellElements.get(Number(cellIndex));

    if (!tokenMotion) return null;

    if (!cellMotion || !cell || !cellMotion.element.isConnected) {
      return {
        x: tokenMotion.targetX,
        y: tokenMotion.targetY,
        scale: tokenMotion.targetScale
      };
    }

    const baseWidth = Number.parseFloat(cell.style.width) || 0;
    const baseHeight = Number.parseFloat(cell.style.height) || 0;
    if (baseWidth <= 0 || baseHeight <= 0) {
      return {
        x: tokenMotion.targetX,
        y: tokenMotion.targetY,
        scale: tokenMotion.targetScale
      };
    }

    // cell transform-origin이 center center이므로 현재/최종 셀 중심을 직접 계산할 수 있다.
    const finalCellCenterX = cellMotion.targetX + (baseWidth * 0.5);
    const finalCellCenterY = cellMotion.targetY + (baseHeight * 0.5);
    const currentCellCenterX = cellMotion.x + (baseWidth * 0.5);
    const currentCellCenterY = cellMotion.y + (baseHeight * 0.5);

    const finalTokenCenterX = tokenMotion.targetX + (TOKEN_BASE_SIZE * 0.5);
    const finalTokenCenterY = tokenMotion.targetY + (TOKEN_BASE_SIZE * 0.5);
    const localX = finalTokenCenterX - finalCellCenterX;
    const localY = finalTokenCenterY - finalCellCenterY;

    const scaleRatio = Math.abs(cellMotion.targetScale) > 0.00001
      ? cellMotion.scale / cellMotion.targetScale
      : 1;

    return {
      x:
        currentCellCenterX +
        (localX * scaleRatio) -
        (TOKEN_BASE_SIZE * 0.5),
      y:
        currentCellCenterY +
        (localY * scaleRatio) -
        (TOKEN_BASE_SIZE * 0.5),
      scale: tokenMotion.targetScale * scaleRatio
    };
  }

  function placeTokenAtCurrentCellVisualTargetV4(playerId, cellIndex) {
    const id = String(playerId);
    const motion = tokenMotionStates.get(id);
    const target = currentVisualTokenTargetV4(id, cellIndex);
    if (!motion || !target) return false;

    motion.x = target.x;
    motion.y = target.y;
    motion.scale = target.scale;
    motion.vx = 0;
    motion.vy = 0;
    motion.vs = 0;
    applyMotionTransform(motion);
    return true;
  }

  function animateTokenStepV4(
    playerId,
    expectedCell,
    visualStart,
    durationMs = STEP_DELAY_MS
  ) {
    const id = String(playerId);
    const start = visualStart || captureTokenVisualState(id);

    return new Promise((resolve) => {
      let settled = false;
      const wallStartedAt = performance.now();
      let frameId = 0;
      let timeoutId = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        if (timeoutId) window.clearTimeout(timeoutId);

        // 최종 layout target으로 스냅하지 않는다.
        // 현재 화면에 보이는 목적지 셀 위치에 정확히 맞춘 뒤 Dock spring에 다시 넘긴다.
        placeTokenAtCurrentCellVisualTargetV4(id, expectedCell);
        releaseDirectTokenLock(id);
        resolve();
      };

      if (!start || !tokenTargetReady(id, expectedCell)) {
        finish();
        return;
      }

      const frame = (timestamp) => {
        if (settled) return;

        const motion = tokenMotionStates.get(id);
        const visualTarget = currentVisualTokenTargetV4(id, expectedCell);
        if (!motion || !motion.element.isConnected || !visualTarget) {
          finish();
          return;
        }

        const progress = clamp(
          (timestamp - wallStartedAt) / Math.max(1, durationMs),
          0,
          1
        );
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - (Math.pow(-2 * progress + 2, 3) / 2);

        motion.x = start.x + ((visualTarget.x - start.x) * eased);
        motion.y = start.y + ((visualTarget.y - start.y) * eased);
        motion.scale = start.scale + ((visualTarget.scale - start.scale) * eased);
        motion.vx = 0;
        motion.vy = 0;
        motion.vs = 0;
        applyMotionTransform(motion);

        if (progress >= 1) {
          finish();
          return;
        }

        frameId = window.requestAnimationFrame(frame);
      };

      frameId = window.requestAnimationFrame(frame);

      // 비정상적인 rAF 중단만 복구한다. 정상 애니메이션보다 충분히 긴 제한으로 조기 절단을 피한다.
      timeoutId = window.setTimeout(
        finish,
        Math.max(900, durationMs * 4)
      );
    });
  }

  async function movePlayerStepsInstant(playerId, steps) {
    const player = state.players.get(String(playerId));
    if (!player) throw new Error("unknown player: " + playerId);

    const signedSteps = Number.parseInt(steps, 10) || 0;
    const direction = signedSteps < 0 ? -1 : 1;
    const distance = Math.abs(signedSteps);
    if (!distance) return { ...player };

    let crossedStart = false;

    // instant 모드는 논리적으로 한 칸씩 계산하되 경유 칸은 화면에 표시하지 않는다.
    for (let moved = 0; moved < distance; moved += 1) {
      const previous = player.position;
      player.position = normalizeCell(player.position + direction);

      if (
        direction > 0 &&
        previous === board.cellCount - 1 &&
        player.position === 0
      ) {
        player.laps += 1;
        state.totalLaps += 1;
        crossedStart = true;
      }
    }

    if (crossedStart) {
      evaluatePhase();
    }

    ensurePlayerTokens();
    moveTokenElementToCell(player.id, player.position);
    syncPlayerTokenParents();
    renderGlobalState();

    try {
      layoutNow();
    } catch (error) {
      console.error("instant movement layout failed", error);
      scheduleLayout();
      await waitForRenderFrame();
    }

    snapAllMotionToTargetsInstant();
    syncPlayerOverlayPosition(player.id, true);
    await waitForRenderFrame();

    return { ...player };
  }

  async function movePlayerStepsActive(playerId, steps) {
    return INSTANT_MOVEMENT_MODE
      ? movePlayerStepsInstant(playerId, steps)
      : movePlayerStepsCoreV8(playerId, steps);
  }

  function playerTokenRect(playerId) {  function playerTokenRect(playerId) {
    const token = playerTokenElements.get(String(playerId));
    if (!token || !token.isConnected) return null;
    return token.getBoundingClientRect();
  }

  function animateMarkerTrackedTokenV8(
    playerId,
    firstRect,
    durationMs = STEP_DELAY_MS,
    isFinalStep = false
  ) {
    const id = String(playerId);
    const token = playerTokenElements.get(id);
    const marker = playerMarkerElements.get(id);

    if (!token || !token.isConnected || !marker || !marker.isConnected || !firstRect) {
      directTokenAnimations.delete(id);
      syncPlayerOverlayPosition(id, true);
      return delay(durationMs);
    }

    const startCenterX = firstRect.left + (firstRect.width * 0.5);
    const startCenterY = firstRect.top + (firstRect.height * 0.5);

    token.dataset.moving = "true";
    setOverlayTokenViewportCenter(id, startCenterX, startCenterY);

    return new Promise((resolve) => {
      let settled = false;
      let startedAt = 0;
      let frameId = 0;
      let timeoutId = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        if (timeoutId) window.clearTimeout(timeoutId);

        token.dataset.moving = "false";
        directTokenAnimations.delete(id);
        syncPlayerOverlayPosition(id, true);
        scheduleMotion();
        resolve();
      };

      const frame = (timestamp) => {
        if (settled) return;
        if (!token.isConnected || !marker.isConnected) {
          finish();
          return;
        }

        if (!startedAt) startedAt = timestamp;
        const progress = clamp(
          (timestamp - startedAt) / Math.max(1, durationMs),
          0,
          1
        );
        const eased = isFinalStep
          ? 1 - Math.pow(1 - progress, 2)
          : progress;

        // 목적지 marker는 셀 spring과 함께 계속 움직일 수 있으므로
        // 매 프레임 최신 절대좌표를 읽어 실제 말의 목적지를 갱신한다.
        const markerRect = marker.getBoundingClientRect();
        const targetCenterX = markerRect.left + (markerRect.width * 0.5);
        const targetCenterY = markerRect.top + (markerRect.height * 0.5);
        const centerX =
          startCenterX + ((targetCenterX - startCenterX) * eased);
        const centerY =
          startCenterY + ((targetCenterY - startCenterY) * eased);

        setOverlayTokenViewportCenter(id, centerX, centerY);

        if (progress >= 1) {
          finish();
          return;
        }

        frameId = window.requestAnimationFrame(frame);
      };

      frameId = window.requestAnimationFrame(frame);
      timeoutId = window.setTimeout(
        finish,
        Math.max(900, durationMs * 4)
      );
    });
  }

  async function movePlayerStepsCoreV8(playerId, steps) {
    const player = state.players.get(String(playerId));
    if (!player) throw new Error("unknown player: " + playerId);

    const signedSteps = Number.parseInt(steps, 10) || 0;
    const direction = signedSteps < 0 ? -1 : 1;
    const distance = Math.abs(signedSteps);
    if (!distance) return { ...player };

    ensurePlayerTokens();
    syncPlayerOverlayPosition(player.id, true);

    for (let moved = 0; moved < distance; moved += 1) {
      const id = String(player.id);
      const previous = player.position;
      const next = normalizeCell(previous + direction);
      const firstRect = playerTokenRect(id);

      // 화면 말은 현 위치에 고정하고, 투명 marker만 다음 칸 player-zone으로 옮긴다.
      // 따라서 논리 경로/reparent는 한 칸씩 유지되면서 렌더링 말은 셀 transform에서 분리된다.
      directTokenAnimations.add(id);
      player.position = next;
      ensurePlayerTokens();
      moveTokenElementToCell(id, next);
      syncPlayerTokenParents();
      renderGlobalState();

      try {
        layoutNow();
      } catch (error) {
        console.error("movement layout step failed; marker remains in destination cell", {
          playerId: id,
          from: previous,
          to: next,
          moved,
          distance,
          error
        });
        scheduleLayout();
      }

      await animateMarkerTrackedTokenV8(
        id,
        firstRect,
        STEP_DELAY_MS,
        moved === distance - 1
      );

      if (
        direction > 0 &&
        previous === board.cellCount - 1 &&
        next === 0
      ) {
        player.laps += 1;
        state.totalLaps += 1;
        evaluatePhase();
      }
    }

    syncPlayerOverlayPosition(player.id, true);
    return { ...player };
  }

  function applyScaleAwareTokenPositionV6(
    token,
    startCenterX,
    startCenterY,
    eased
  ) {
    if (!token || !token.isConnected) return false;

    // 자연 위치를 읽을 때만 보정 transform을 제거한다.
    // 같은 JS/rAF 실행 안에서 다시 transform을 적용하므로 중간 상태는 paint되지 않는다.
    token.style.transform = "translate3d(0,0,0)";
    const naturalRect = token.getBoundingClientRect();

    const targetCenterX =
      naturalRect.left + (naturalRect.width * 0.5);
    const targetCenterY =
      naturalRect.top + (naturalRect.height * 0.5);

    const desiredCenterX =
      startCenterX + ((targetCenterX - startCenterX) * eased);
    const desiredCenterY =
      startCenterY + ((targetCenterY - startCenterY) * eased);

    const localWidth = Math.max(
      0.0001,
      token.offsetWidth || TOKEN_BASE_SIZE
    );
    const localHeight = Math.max(
      0.0001,
      token.offsetHeight || TOKEN_BASE_SIZE
    );
    const parentScaleX = Math.max(
      0.0001,
      naturalRect.width / localWidth
    );
    const parentScaleY = Math.max(
      0.0001,
      naturalRect.height / localHeight
    );

    const localDx =
      (desiredCenterX - targetCenterX) / parentScaleX;
    const localDy =
      (desiredCenterY - targetCenterY) / parentScaleY;

    token.style.transform =
      "translate3d(" + localDx.toFixed(3) + "px," +
      localDy.toFixed(3) + "px,0)";

    return true;
  }

  function acquireMovingTokenLayerV7(token) {
    const cell = token && token.closest
      ? token.closest(".board-cell")
      : null;
    if (!cell) return null;

    let state = movingTokenLayerStates.get(cell);
    if (!state) {
      state = {
        count: 0,
        previousZIndex: cell.style.zIndex
      };
      movingTokenLayerStates.set(cell, state);
    }

    state.count += 1;
    if (state.count === 1) {
      cell.style.zIndex = "100";
      cell.dataset.movingTokenLayer = "true";
    }

    return cell;
  }

  function releaseMovingTokenLayerV7(cell) {
    if (!cell) return;

    const state = movingTokenLayerStates.get(cell);
    if (!state) return;

    state.count = Math.max(0, state.count - 1);
    if (state.count > 0) return;

    cell.style.zIndex = state.previousZIndex;
    delete cell.dataset.movingTokenLayer;
    movingTokenLayerStates.delete(cell);
  }

  function animateReparentedTokenV6(
    playerId,
    firstRect,
    durationMs = STEP_DELAY_MS,
    isFinalStep = false
  ) {
    const id = String(playerId);
    const token = playerTokenElements.get(id);
    if (!token || !token.isConnected || !firstRect) {
      return delay(durationMs);
    }

    if (INSTANT_MOVEMENT_MODE) {
      token.style.transform = "";
      return Promise.resolve();
    }

    // 토큰 자체의 z-index만으로는 부모 board-cell stacking context를 벗어날 수 없다.
    // 이동 중에는 현재 목적지 부모 셀을 다른 모든 일반 셀보다 위로 올린다.
    const movingLayerCell = acquireMovingTokenLayerV7(token);

    const startCenterX = firstRect.left + (firstRect.width * 0.5);
    const startCenterY = firstRect.top + (firstRect.height * 0.5);

    // 중요: reparent/layout 직후, 브라우저가 다음 프레임을 그리기 전에
    // progress=0 inverse를 즉시 적용한다.
    // 목적지 셀 위치가 한 프레임 노출되는 경계 튐을 차단한다.
    if (!applyScaleAwareTokenPositionV6(
      token,
      startCenterX,
      startCenterY,
      0
    )) {
      releaseMovingTokenLayerV7(movingLayerCell);
      return delay(durationMs);
    }

    return new Promise((resolve) => {
      let settled = false;
      let startedAt = 0;
      let frameId = 0;
      let timeoutId = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        if (timeoutId) window.clearTimeout(timeoutId);
        token.style.transform = "";
        releaseMovingTokenLayerV7(movingLayerCell);
        resolve();
      };

      const frame = (timestamp) => {
        if (settled) return;
        if (!token.isConnected) {
          finish();
          return;
        }

        if (!startedAt) startedAt = timestamp;
        const progress = clamp(
          (timestamp - startedAt) / Math.max(1, durationMs),
          0,
          1
        );
        const eased = isFinalStep
          ? 1 - Math.pow(1 - progress, 2)
          : progress;

        if (!applyScaleAwareTokenPositionV6(
          token,
          startCenterX,
          startCenterY,
          eased
        )) {
          finish();
          return;
        }

        if (progress >= 1) {
          finish();
          return;
        }

        frameId = window.requestAnimationFrame(frame);
      };

      frameId = window.requestAnimationFrame(frame);
      timeoutId = window.setTimeout(
        finish,
        Math.max(900, durationMs * 4)
      );
    });
  }

  async function movePlayerStepsCoreV6(playerId, steps) {
    const player = state.players.get(String(playerId));
    if (!player) throw new Error("unknown player: " + playerId);

    const signedSteps = Number.parseInt(steps, 10) || 0;
    const direction = signedSteps < 0 ? -1 : 1;
    const distance = Math.abs(signedSteps);
    if (!distance) return { ...player };

    ensurePlayerTokens();

    for (let moved = 0; moved < distance; moved += 1) {
      const previous = player.position;
      const next = normalizeCell(previous + direction);
      const firstRect = playerTokenRect(player.id);

      // 게임 상태를 먼저 한 칸 진행하고 토큰 DOM 자체를 목적지 셀 내부로 이동한다.
      player.position = next;
      ensurePlayerTokens();
      moveTokenElementToCell(player.id, next);
      syncPlayerTokenParents();
      renderGlobalState();

      // 셀/Dock 레이아웃은 기존 solver를 그대로 사용한다.
      // 실패해도 토큰은 이미 논리 목적지 셀의 자식이므로 이동량은 영향을 받지 않는다.
      try {
        layoutNow();
      } catch (error) {
        console.error("movement layout step failed; token remains in destination cell", {
          playerId: player.id,
          from: previous,
          to: next,
          moved,
          distance,
          error
        });
        scheduleLayout();
      }

      await animateReparentedTokenV6(
        player.id,
        firstRect,
        STEP_DELAY_MS,
        moved === distance - 1
      );

      if (
        direction > 0 &&
        previous === board.cellCount - 1 &&
        next === 0
      ) {
        player.laps += 1;
        state.totalLaps += 1;
        evaluatePhase();
      }
    }

    return { ...player };
  }

  function movementFallbackTargetFromCurrentCell(playerId, cellIndex) {
    const id = String(playerId);
    const cell = cellElements.get(Number(cellIndex));
    const cellMotion = cellMotionStates.get(Number(cellIndex));
    if (!cell || !cellMotion || !cellMotion.element.isConnected) return null;

    const baseWidth = Number.parseFloat(cell.style.width) || 0;
    const baseHeight = Number.parseFloat(cell.style.height) || 0;
    if (baseWidth <= 0 || baseHeight <= 0) return null;

    // 마지막 정상 레이아웃에서 현재 화면에 보이는 셀 geometry를 재사용한다.
    // 전체 보드 solver가 실패해도 목적지 칸 자체의 화면 위치는 이미 존재한다.
    const geometry = {
      centerX: cellMotion.x + (baseWidth * 0.5),
      centerY: cellMotion.y + (baseHeight * 0.5),
      width: baseWidth * cellMotion.scale,
      height: baseHeight * cellMotion.scale,
      point: {
        angle: Number.parseFloat(cell.dataset.pathAngle) || 0,
        curved: cell.dataset.curved === "true"
      }
    };

    const occupancy = occupancyByCell();
    const players = (occupancy.get(Number(cellIndex)) || []).slice(0, MAX_PLAYERS);
    const playerIndex = players.findIndex((player) => String(player.id) === id);
    if (playerIndex < 0) return null;

    const playerZone = playerZoneForGeometry(geometry);
    const allowOverflow = players.length >= 3;
    const tokenSize = clamp(
      Math.min(geometry.width, geometry.height) * 0.46,
      18,
      62
    );
    const layout = tokenLayout(
      players.length,
      tokenSize,
      allowOverflow ? geometry : playerZone,
      allowOverflow
    );
    const slot = layout.slots[playerIndex] || { tangent: 0, depth: 0 };

    const tangentX = Math.cos(geometry.point.angle);
    const tangentY = Math.sin(geometry.point.angle);
    const inwardX = -tangentY;
    const inwardY = tangentX;
    const tokenRadius = tokenSize * 0.5;
    const edgePadding = PLAYER_EDGE_PADDING;
    const zoneDepth =
      playerZone.edge === "top" || playerZone.edge === "bottom"
        ? playerZone.height
        : playerZone.width;
    const boundaryX =
      playerZone.centerX - (inwardX * zoneDepth * 0.5);
    const boundaryY =
      playerZone.centerY - (inwardY * zoneDepth * 0.5);
    const inwardOffset = tokenRadius + edgePadding;

    let centerX =
      boundaryX +
      (inwardX * (inwardOffset + slot.depth)) +
      (tangentX * slot.tangent);
    let centerY =
      boundaryY +
      (inwardY * (inwardOffset + slot.depth)) +
      (tangentY * slot.tangent);

    if (!allowOverflow) {
      const cellMinX = geometry.centerX - (geometry.width * 0.5);
      const cellMaxX = geometry.centerX + (geometry.width * 0.5);
      const cellMinY = geometry.centerY - (geometry.height * 0.5);
      const cellMaxY = geometry.centerY + (geometry.height * 0.5);

      centerX = clamp(
        centerX,
        cellMinX + tokenRadius + edgePadding,
        cellMaxX - tokenRadius - edgePadding
      );
      centerY = clamp(
        centerY,
        cellMinY + tokenRadius + edgePadding,
        cellMaxY - tokenRadius - edgePadding
      );
    }

    return {
      x: centerX - (TOKEN_BASE_SIZE * 0.5),
      y: centerY - (TOKEN_BASE_SIZE * 0.5),
      scale: tokenSize / TOKEN_BASE_SIZE
    };
  }

  function animateTokenStepV5(
    playerId,
    targetX,
    targetY,
    targetScale,
    visualStart,
    durationMs = STEP_DELAY_MS
  ) {
    const id = String(playerId);
    const start = visualStart || captureTokenVisualState(id);

    return new Promise((resolve) => {
      let settled = false;
      const startedAt = performance.now();
      let frameId = 0;
      let timeoutId = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (frameId) window.cancelAnimationFrame(frameId);
        if (timeoutId) window.clearTimeout(timeoutId);

        const motion = tokenMotionStates.get(id);
        if (motion && motion.element.isConnected) {
          motion.x = targetX;
          motion.y = targetY;
          motion.scale = targetScale;
          motion.vx = 0;
          motion.vy = 0;
          motion.vs = 0;
          applyMotionTransform(motion);
        }

        releaseDirectTokenLock(id);
        resolve();
      };

      if (!start) {
        finish();
        return;
      }

      const frame = (timestamp) => {
        if (settled) return;

        const motion = tokenMotionStates.get(id);
        if (!motion || !motion.element.isConnected) {
          finish();
          return;
        }

        const progress = clamp(
          (timestamp - startedAt) / Math.max(1, durationMs),
          0,
          1
        );
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - (Math.pow(-2 * progress + 2, 3) / 2);

        motion.x = start.x + ((targetX - start.x) * eased);
        motion.y = start.y + ((targetY - start.y) * eased);
        motion.scale = start.scale + ((targetScale - start.scale) * eased);
        motion.vx = 0;
        motion.vy = 0;
        motion.vs = 0;
        applyMotionTransform(motion);

        if (progress >= 1) {
          finish();
          return;
        }

        frameId = window.requestAnimationFrame(frame);
      };

      frameId = window.requestAnimationFrame(frame);
      timeoutId = window.setTimeout(
        finish,
        Math.max(900, durationMs * 4)
      );
    });
  }

  async function movePlayerStepsCoreV5(playerId, steps) {
    const player = state.players.get(String(playerId));
    if (!player) throw new Error("unknown player: " + playerId);

    const signedSteps = Number.parseInt(steps, 10) || 0;
    const direction = signedSteps < 0 ? -1 : 1;
    const distance = Math.abs(signedSteps);
    if (!distance) return { ...player };

    for (let moved = 0; moved < distance; moved += 1) {
      const id = String(player.id);
      const previous = player.position;
      const next = normalizeCell(previous + direction);

      directTokenAnimations.add(id);
      const visualStart = captureTokenVisualState(id);

      // 목적지는 논리 위치로 항상 확정된다.
      player.position = next;
      ensurePlayerTokens();
      renderGlobalState();

      // 레이아웃 재계산 실패는 시각 배치 실패일 뿐 이동량을 취소하지 않는다.
      // 성공하면 새 solver target을 사용하고, 실패하면 마지막 정상 레이아웃에서
      // 목적지 칸의 현재 화면 위치를 계산해 이동을 계속한다.
      let layoutSucceeded = true;
      try {
        layoutNow();
      } catch (error) {
        layoutSucceeded = false;
        console.error("movement layout step failed; continuing movement", {
          playerId: id,
          from: previous,
          to: next,
          moved,
          distance,
          error
        });
        if (refs.boardStage) {
          const current = Number.parseInt(
            refs.boardStage.dataset.movementLayoutFallbackCount || "0",
            10
          ) || 0;
          refs.boardStage.dataset.movementLayoutFallbackCount =
            String(current + 1);
        }
      }

      const motion = tokenMotionStates.get(id);
      const fallbackTarget = movementFallbackTargetFromCurrentCell(id, next);
      const target =
        layoutSucceeded &&
        motion &&
        motion.element.isConnected &&
        Number.isFinite(motion.targetX) &&
        Number.isFinite(motion.targetY) &&
        Number.isFinite(motion.targetScale)
          ? {
              x: motion.targetX,
              y: motion.targetY,
              scale: motion.targetScale
            }
          : fallbackTarget;

      if (!target) {
        // DOM 자체가 사라진 비정상 상태에서도 논리 이동 루프는 끊지 않는다.
        // 토큰을 다시 만든 뒤 일반 레이아웃을 예약하고 다음 스텝까지 진행한다.
        ensurePlayerTokens();
        scheduleLayout();
        releaseDirectTokenLock(id);
        await delay(STEP_DELAY_MS);
      } else {
        await animateTokenStepV5(
          id,
          target.x,
          target.y,
          target.scale,
          visualStart,
          STEP_DELAY_MS
        );
      }

      if (!layoutSucceeded) {
        // 실패한 보드 재배치는 이동을 막지 않고 다음 rAF에서 다시 시도한다.
        scheduleLayout();
      }

      if (
        direction > 0 &&
        previous === board.cellCount - 1 &&
        next === 0
      ) {
        player.laps += 1;
        state.totalLaps += 1;
        evaluatePhase();
      }
    }

    releaseDirectTokenLock(player.id);
    scheduleMotion();
    return { ...player };
  }

  async function movePlayerStepsCoreV4(playerId, steps) {
    const player = state.players.get(String(playerId));
    if (!player) throw new Error("unknown player: " + playerId);

    const signedSteps = Number.parseInt(steps, 10) || 0;
    const direction = signedSteps < 0 ? -1 : 1;
    const distance = Math.abs(signedSteps);
    if (!distance) return { ...player };

    for (let moved = 0; moved < distance; moved += 1) {
      const id = String(player.id);
      const previous = player.position;
      const next = normalizeCell(previous + direction);

      directTokenAnimations.add(id);
      const visualStart = captureTokenVisualState(id);

      player.position = next;
      ensurePlayerTokens();
      renderGlobalState();

      const targetReady = await acquireMovementTargetV3(
        id,
        next,
        visualStart
      );

      if (!targetReady) {
        player.position = previous;
        ensurePlayerTokens();
        renderGlobalState();
        scheduleLayout();
        restoreTokenVisualState(id, visualStart);
        releaseDirectTokenLock(id);
        await waitForRenderFrame();
        throw new Error(
          "movement target unavailable: " + id + " -> " + next
        );
      }

      await animateTokenStepV4(
        id,
        next,
        visualStart,
        STEP_DELAY_MS
      );

      if (
        direction > 0 &&
        previous === board.cellCount - 1 &&
        next === 0
      ) {
        player.laps += 1;
        state.totalLaps += 1;
        evaluatePhase();
      }
    }

    // 최종 셀의 현재 화면 위치에서 종료한다. 최종 layout target 스냅은 하지 않는다.
    placeTokenAtCurrentCellVisualTargetV4(player.id, player.position);
    releaseDirectTokenLock(player.id);
    scheduleMotion();
    return { ...player };
  }

  async function movePlayerBy(playerId, steps, meta = {}) {
    const movedPlayer = await movePlayerStepsActive(playerId, steps);
    const player = state.players.get(String(playerId));
    if (!player) return movedPlayer;

    if (!meta.suppressDestinationEvent) {
      const command = destinationCommand(player.position);
      const source = meta.source ? " (" + meta.source + ")" : "";

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

  const demoEffectStates = new Map();

  function demoEffectState(playerId) {
    const id = String(playerId);
    if (!demoEffectStates.has(id)) {
      demoEffectStates.set(id, {
        skipNextThrows: 0,
        nextThrowMultiplier: 1,
        ignoreNextLandingEffects: 0
      });
    }
    return demoEffectStates.get(id);
  }

  function renderDemoEffectBadges(playerId) {
    const token = playerTokenElements.get(String(playerId));
    if (!token) return;

    const root = token.querySelector(".player-effect-badges");
    if (!root) return;
    root.innerHTML = "";

    if (!DEMO_MODE) {
      root.dataset.visible = "false";
      token.dataset.hasEffects = "false";
      return;
    }

    const effects = demoEffectStates.get(String(playerId));
    if (!effects) {
      root.dataset.visible = "false";
      token.dataset.hasEffects = "false";
      return;
    }

    const badges = [];
    if (effects.skipNextThrows > 0) {
      badges.push({
        effect: "skip",
        text: effects.skipNextThrows > 1
          ? "무효×" + effects.skipNextThrows
          : "무효"
      });
    }
    if (effects.nextThrowMultiplier > 1) {
      badges.push({
        effect: "multiplier",
        text: "×" + effects.nextThrowMultiplier
      });
    }
    if (effects.ignoreNextLandingEffects > 0) {
      badges.push({
        effect: "ignore",
        text: effects.ignoreNextLandingEffects > 1
          ? "칸 무효×" + effects.ignoreNextLandingEffects
          : "칸 무효"
      });
    }

    for (const badge of badges) {
      const element = document.createElement("span");
      element.className = "player-effect-badge";
      element.dataset.effect = badge.effect;
      element.textContent = badge.text;
      root.append(element);
    }

    root.dataset.visible = String(badges.length > 0);
    token.dataset.hasEffects = String(badges.length > 0);
  }

  function flashDemoInstructionCell(cellIndex, mode = "triggered", duration = 560) {
    const index = normalizeCell(cellIndex);
    const cell = cellElements.get(index);
    if (!cell) return;

    const previousTimer = instructionFlashTimers.get(index);
    if (previousTimer) window.clearTimeout(previousTimer);

    cell.dataset.instructionFlash = mode;
    const timer = window.setTimeout(() => {
      if (cell.dataset.instructionFlash === mode) {
        delete cell.dataset.instructionFlash;
      }
      instructionFlashTimers.delete(index);
    }, duration);
    instructionFlashTimers.set(index, timer);
  }

  function demoRawThrowSteps(event) {
    if (event.generator === "dice") {
      return (event.dice?.values || []).reduce(
        (sum, value) => sum + (Number(value) || 0),
        0
      );
    }

    const stepByName = {
      BACK_DO: -1,
      DO: 1,
      GAE: 2,
      GEOL: 3,
      YUT: 4,
      MO: 5
    };
    return stepByName[String(event.yut?.name || "DO").toUpperCase()] || 0;
  }

  function applyDemoThrowEffects(event) {
    const effects = demoEffectState(event.playerId);
    const multiplier = Math.max(1, effects.nextThrowMultiplier || 1);
    effects.nextThrowMultiplier = 1;
    renderDemoEffectBadges(event.playerId);
    const rawSteps = demoRawThrowSteps(event);

    return {
      ...event,
      resolvedSteps: rawSteps * multiplier,
      appliedMultiplier: multiplier
    };
  }

  function emitDemoInstruction(player, definition, extra = {}) {
    const command = definition.command || definition.label || "";
    window.dispatchEvent(new CustomEvent("ramyani-board:command", {
      detail: {
        playerId: player.id,
        position: player.position,
        command,
        source: "데모",
        ...extra
      }
    }));
  }

  const DEMO_MAX_BONUS_CHAIN = 32;
  const DEMO_MAX_LANDING_CHAIN = 64;

  function copyDemoEffects(source) {
    return {
      skipNextThrows: Math.max(0, Number(source?.skipNextThrows) || 0),
      nextThrowMultiplier: Math.max(1, Number(source?.nextThrowMultiplier) || 1),
      ignoreNextLandingEffects: Math.max(
        0,
        Number(source?.ignoreNextLandingEffects) || 0
      )
    };
  }

  function commitDemoEffects(playerId, snapshot) {
    const effects = demoEffectState(playerId);
    effects.skipNextThrows = Math.max(0, Number(snapshot.skipNextThrows) || 0);
    effects.nextThrowMultiplier = Math.max(
      1,
      Number(snapshot.nextThrowMultiplier) || 1
    );
    effects.ignoreNextLandingEffects = Math.max(
      0,
      Number(snapshot.ignoreNextLandingEffects) || 0
    );
    renderDemoEffectBadges(playerId);
  }

  function demoAdvancePosition(position, steps) {
    return normalizeCell(position + (Number.parseInt(steps, 10) || 0));
  }

  function resolveDemoLandingPlan(startPosition, initialEffects) {
    const effects = copyDemoEffects(initialEffects);
    const landings = [];
    let position = normalizeCell(startPosition);
    let safetyStopped = false;

    for (let depth = 0; depth < DEMO_MAX_LANDING_CHAIN; depth += 1) {
      const definition = cellDefinition(position);
      const command = definition.command || "";
      let actionMoveSteps = null;
      let effectIgnored = false;

      if (effects.ignoreNextLandingEffects > 0) {
        effects.ignoreNextLandingEffects -= 1;
        effectIgnored = true;
      } else if (definition.instructionType === "skip") {
        effects.skipNextThrows += 1;
      } else if (definition.instructionType === "multiplier") {
        const match = command.match(/(\d+)배/);
        effects.nextThrowMultiplier = Math.max(
          2,
          Number.parseInt(match?.[1] || "2", 10) || 2
        );
      } else if (definition.instructionType === "ignore") {
        effects.ignoreNextLandingEffects += 1;
      } else if (
        definition.instructionType === "forward" ||
        definition.instructionType === "backward"
      ) {
        const magnitude = Math.max(
          1,
          Number.parseInt(command, 10) || 1
        );
        actionMoveSteps =
          definition.instructionType === "backward"
            ? -magnitude
            : magnitude;
      }

      const landing = {
        depth,
        position,
        definition,
        command,
        actionMoveSteps,
        effectIgnored,
        effectsAfter: copyDemoEffects(effects)
      };

      if (actionMoveSteps !== null) {
        landing.destination = demoAdvancePosition(position, actionMoveSteps);
      } else {
        landing.destination = position;
      }

      landings.push(landing);

      if (actionMoveSteps === null || landing.destination === position) {
        return {
          startPosition: normalizeCell(startPosition),
          endPosition: position,
          effectsAfter: copyDemoEffects(effects),
          landings,
          safetyStopped: false
        };
      }

      position = landing.destination;
    }

    safetyStopped = true;
    return {
      startPosition: normalizeCell(startPosition),
      endPosition: position,
      effectsAfter: copyDemoEffects(effects),
      landings,
      safetyStopped
    };
  }

  function resolveDemoThrowPlan(player, generator) {
    const currentEffects = copyDemoEffects(demoEffectState(player.id));
    const rawEvent = generator === "yut"
      ? resolveDemoYut(player.id)
      : resolveDemoDice(player.id);

    const appliedMultiplier = Math.max(
      1,
      currentEffects.nextThrowMultiplier || 1
    );
    currentEffects.nextThrowMultiplier = 1;

    const rawSteps = demoRawThrowSteps(rawEvent);
    const effectiveSteps = rawSteps * appliedMultiplier;
    const throwStart = player.position;
    const throwLanding = demoAdvancePosition(throwStart, effectiveSteps);
    let pendingBonusThrows = rawEvent.bonusThrow ? 1 : 0;

    const landingPlan = resolveDemoLandingPlan(
      throwLanding,
      currentEffects
    );

    let effectsAfter = copyDemoEffects(landingPlan.effectsAfter);
    let nextThrowScheduled = false;
    let bonusConsumedBySkip = false;

    while (pendingBonusThrows > 0 && !nextThrowScheduled) {
      if (effectsAfter.skipNextThrows > 0) {
        pendingBonusThrows -= 1;
        effectsAfter.skipNextThrows -= 1;
        bonusConsumedBySkip = true;
      } else {
        pendingBonusThrows -= 1;
        nextThrowScheduled = true;
      }
    }

    const event = normalizeThrowEvent({
      ...rawEvent,
      resolvedSteps: effectiveSteps,
      appliedMultiplier
    });

    return {
      event,
      throwStart,
      throwLanding,
      effectiveSteps,
      landingPlan,
      endPosition: landingPlan.endPosition,
      effectsAfter,
      naturalBonus: Boolean(rawEvent.bonusThrow),
      nextThrowScheduled,
      bonusConsumedBySkip,
      safetyStopped: Boolean(landingPlan.safetyStopped)
    };
  }

  function assertDemoPosition(player, expected, stage) {
    const actual = normalizeCell(player.position);
    const normalizedExpected = normalizeCell(expected);
    if (actual === normalizedExpected) return;

    throw new Error(
      "demo position mismatch at " + stage +
      ": expected " + normalizedExpected +
      ", actual " + actual
    );
  }

  async function playDemoLandingPlan(player, plan) {
    for (const landing of plan.landings) {
      assertDemoPosition(player, landing.position, "landing");

      const definition = landing.definition;
      const command = landing.command || "";

      if (landing.effectIgnored) {
        commitDemoEffects(player.id, landing.effectsAfter);
        flashDemoInstructionCell(landing.position, "ignored", 620);
        setEventMessage(
          player.name + ": " + (command || "현재 칸") + " 효과 무효"
        );
        emitDemoInstruction(player, definition, {
          effectIgnored: true,
          chainDepth: landing.depth
        });
        await delay(INSTANT_MOVEMENT_MODE ? 500 : 420);
        return;
      }

      if (!command) {
        commitDemoEffects(player.id, landing.effectsAfter);
        setEventMessage(player.name + " 이동 완료");
        return;
      }

      flashDemoInstructionCell(
        landing.position,
        landing.depth > 0 ? "chain" : "triggered",
        620
      );

      if (landing.actionMoveSteps !== null) {
        setEventMessage(
          player.name + ": " + command +
          (landing.depth > 0 ? " (연쇄)" : "")
        );
        emitDemoInstruction(player, definition, {
          actionMoveSteps: landing.actionMoveSteps,
          chainDepth: landing.depth
        });

        await delay(INSTANT_MOVEMENT_MODE ? 500 : 300);
        await movePlayerStepsActive(
          player.id,
          landing.actionMoveSteps
        );
        assertDemoPosition(
          player,
          landing.destination,
          "instruction move"
        );
        await delay(INSTANT_MOVEMENT_MODE ? 400 : 140);
        continue;
      }

      commitDemoEffects(player.id, landing.effectsAfter);

      if (definition.instructionType === "skip") {
        setEventMessage(player.name + ": 다음 던지기 무효 획득");
        emitDemoInstruction(player, definition, {
          skipNextThrows: landing.effectsAfter.skipNextThrows
        });
      } else if (definition.instructionType === "multiplier") {
        setEventMessage(
          player.name + ": 다음 던지기 " +
          landing.effectsAfter.nextThrowMultiplier + "배 적용 대기"
        );
        emitDemoInstruction(player, definition, {
          nextThrowMultiplier:
            landing.effectsAfter.nextThrowMultiplier
        });
      } else if (definition.instructionType === "ignore") {
        setEventMessage(player.name + ": 다음 칸 효과 무효화 대기");
        emitDemoInstruction(player, definition, {
          ignoreNextLandingEffects:
            landing.effectsAfter.ignoreNextLandingEffects
        });
      } else {
        emitDemoInstruction(player, definition, {
          chainDepth: landing.depth
        });
      }

      await delay(INSTANT_MOVEMENT_MODE ? 500 : 420);
      return;
    }
  }

  async function playDemoThrowPlan(player, plan) {
    const event = plan.event;
    const id = player.id;
    const presentation = reserveThrowPresentation(event, player);

    window.dispatchEvent(new CustomEvent("ramyani-board:throwstarted", {
      detail: { event, source: "데모" }
    }));

    await presentation.reveal;
    showPlayerResultBubble(id, event);

    window.dispatchEvent(new CustomEvent("ramyani-board:throwrevealed", {
      detail: { event, source: "데모" }
    }));

    try {
      await movePlayerStepsActive(id, plan.effectiveSteps);
      assertDemoPosition(player, plan.throwLanding, "throw landing");

      window.dispatchEvent(new CustomEvent("ramyani-board:movementcompleted", {
        detail: {
          event,
          playerId: id,
          position: player.position,
          bonusThrow: plan.naturalBonus,
          source: "데모"
        }
      }));

      await playDemoLandingPlan(player, plan.landingPlan);
      assertDemoPosition(player, plan.endPosition, "landing chain end");

      // 서버와 동일하게 전체 착지 연쇄가 끝난 뒤 보너스/스킵 소비 결과를 확정한다.
      commitDemoEffects(id, plan.effectsAfter);

      if (plan.bonusConsumedBySkip) {
        setEventMessage(player.name + ": 보너스 던지기 무효");
        await delay(INSTANT_MOVEMENT_MODE ? 500 : 420);
      }

      await presentation.finished;
    } finally {
      await delay(180);
      hidePlayerResultBubble(id);
    }
  }

  /*
   * 기존 데모 착지 resolver는 회귀 비교용으로 보존한다.
   * active 데모 턴에서는 사용하지 않는다.
   */
  async function resolveDemoLandingChain(player) {
    const effects = demoEffectState(player.id);
    const visitedMoves = new Set();

    const maxChainDepth = Math.min(16, Math.max(1, board.cellCount));
    for (let depth = 0; depth < maxChainDepth; depth += 1) {
      const definition = cellDefinition(player.position);
      const command = definition.command || "";

      if (effects.ignoreNextLandingEffects > 0) {
        effects.ignoreNextLandingEffects -= 1;
        renderDemoEffectBadges(player.id);
        flashDemoInstructionCell(player.position, "ignored", 620);
        setEventMessage(
          player.name + ": " + (command || "현재 칸") + " 효과 무효"
        );
        emitDemoInstruction(player, definition, { effectIgnored: true });
        await delay(420);
        return { safetyStopped: false };
      }

      if (!command) {
        setEventMessage(player.name + " 이동 완료");
        return { safetyStopped: false };
      }

      flashDemoInstructionCell(
        player.position,
        depth > 0 ? "chain" : "triggered",
        620
      );

      if (
        definition.instructionType === "forward" ||
        definition.instructionType === "backward"
      ) {
        const steps = Math.max(1, Number.parseInt(command, 10) || 1);
        const signedSteps =
          definition.instructionType === "backward" ? -steps : steps;
        const visitKey = player.position + ":" + signedSteps;

        if (visitedMoves.has(visitKey)) {
          setEventMessage(player.name + ": 이동 지시문 순환 중단");
          emitDemoInstruction(player, definition, { safetyStopped: true });
          return { safetyStopped: true };
        }
        visitedMoves.add(visitKey);

        setEventMessage(
          player.name + ": " + command +
          (depth > 0 ? " (연쇄)" : "")
        );
        emitDemoInstruction(player, definition, {
          actionMoveSteps: signedSteps,
          chainDepth: depth
        });

        // 지시문 발동을 눈으로 확인한 뒤 추가 이동을 시작한다.
        await delay(INSTANT_MOVEMENT_MODE ? 500 : 300);
        await movePlayerStepsActive(player.id, signedSteps);
        // instant 진단에서는 새 착지칸을 충분히 보여준 뒤 다음 판정을 진행한다.
        await delay(INSTANT_MOVEMENT_MODE ? 400 : 140);
        continue;
      }

      if (definition.instructionType === "skip") {
        effects.skipNextThrows += 1;
        renderDemoEffectBadges(player.id);
        setEventMessage(player.name + ": 다음 던지기 무효 획득");
        emitDemoInstruction(player, definition, {
          skipNextThrows: effects.skipNextThrows
        });
        await delay(420);
        return { safetyStopped: false };
      }

      if (definition.instructionType === "multiplier") {
        const match = command.match(/(\d+)배/);
        effects.nextThrowMultiplier = Math.max(
          2,
          Number.parseInt(match?.[1] || "2", 10) || 2
        );
        renderDemoEffectBadges(player.id);
        setEventMessage(
          player.name + ": 다음 던지기 " +
          effects.nextThrowMultiplier + "배 적용 대기"
        );
        emitDemoInstruction(player, definition, {
          nextThrowMultiplier: effects.nextThrowMultiplier
        });
        await delay(420);
        return { safetyStopped: false };
      }

      if (definition.instructionType === "ignore") {
        effects.ignoreNextLandingEffects += 1;
        renderDemoEffectBadges(player.id);
        setEventMessage(player.name + ": 다음 칸 효과 무효화 대기");
        emitDemoInstruction(player, definition, {
          ignoreNextLandingEffects: effects.ignoreNextLandingEffects
        });
        await delay(420);
        return { safetyStopped: false };
      }

      emitDemoInstruction(player, definition);
      return { safetyStopped: false };
    }

    setEventMessage(player.name + ": 지시문 연쇄 안전 제한 도달");
    return { safetyStopped: true };
  }

  const DEMO_INSTRUCTION_TYPES = [
    "forward",
    "backward",
    "skip",
    "multiplier",
    "ignore"
  ];

  function demoInstructionDefinition(type) {
    if (type === "forward") {
      const steps = 1 + Math.floor(Math.random() * 5);
      return {
        label: steps + "칸 앞으로",
        command: steps + "칸 앞으로",
        kind: "instruction",
        instructionType: "forward"
      };
    }

    if (type === "backward") {
      const steps = 1 + Math.floor(Math.random() * 4);
      return {
        label: steps + "칸 뒤로",
        command: steps + "칸 뒤로",
        kind: "instruction",
        instructionType: "backward"
      };
    }

    if (type === "skip") {
      return {
        label: "다음 던지기 무효",
        command: "다음 던지기 무효",
        kind: "instruction",
        instructionType: "skip"
      };
    }

    if (type === "multiplier") {
      const multiplier = 2 + Math.floor(Math.random() * 3);
      return {
        label: "다음 던지기 " + multiplier + "배",
        command: "다음 던지기 " + multiplier + "배",
        kind: "instruction",
        instructionType: "multiplier"
      };
    }

    return {
      label: "다음 칸 무효화",
      command: "다음 칸 무효화",
      kind: "instruction",
      instructionType: "ignore"
    };
  }

  function demoMovementCycleExists(cells) {
    const movementNodes = new Set();

    for (const [key, definition] of Object.entries(cells)) {
      if (
        definition?.instructionType === "forward" ||
        definition?.instructionType === "backward"
      ) {
        movementNodes.add(Number(key));
      }
    }

    for (const start of movementNodes) {
      const seen = new Set();
      let current = start;

      while (movementNodes.has(current)) {
        if (seen.has(current)) return true;
        seen.add(current);

        const definition = cells[current];
        const steps = Math.max(
          1,
          Number.parseInt(definition?.command || "", 10) || 1
        );
        const signedSteps =
          definition?.instructionType === "backward" ? -steps : steps;
        current = normalizeCell(current + signedSteps);
      }
    }

    return false;
  }

  function buildDemoInstructionCells(candidates, instructionCount) {
    const cells = {};

    for (let index = 0; index < instructionCount; index += 1) {
      const cellIndex = candidates[index];
      const type = DEMO_INSTRUCTION_TYPES[index % DEMO_INSTRUCTION_TYPES.length];
      cells[cellIndex] = demoInstructionDefinition(type);
    }

    return cells;
  }

  function seedDemoInstructions() {
    const baseCandidates = Array.from(
      { length: Math.max(0, board.cellCount - 1) },
      (_, index) => index + 1
    );

    const instructionCount = clamp(
      Math.round(board.cellCount * 0.28),
      DEMO_INSTRUCTION_TYPES.length,
      15
    );

    let cells = {};

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidates = baseCandidates.slice();

      for (let index = candidates.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [candidates[index], candidates[swapIndex]] = [
          candidates[swapIndex],
          candidates[index]
        ];
      }

      cells = buildDemoInstructionCells(candidates, instructionCount);
      if (!demoMovementCycleExists(cells)) break;
      cells = {};
    }

    if (!Object.keys(cells).length) {
      // 극단적인 경우에도 데모 시작 자체가 막히지 않도록 이동 지시문을 제외한 안전 배치로 fallback.
      const candidates = baseCandidates.slice(0, instructionCount);
      cells = {};
      for (let index = 0; index < candidates.length; index += 1) {
        const safeTypes = ["skip", "multiplier", "ignore"];
        cells[candidates[index]] = demoInstructionDefinition(
          safeTypes[index % safeTypes.length]
        );
      }
    }

    setPhasePlan([
      {
        id: "phase-1",
        minTotalLaps: 0,
        label: "PHASE 1",
        description: "기본 제공 지시문 데모",
        cells
      }
    ]);
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
    const effects = demoEffectState(player.id);

    // 서버와 동일하게 턴 시작 시 skip을 가장 먼저 소비한다.
    if (effects.skipNextThrows > 0) {
      effects.skipNextThrows -= 1;
      renderDemoEffectBadges(player.id);
      setEventMessage(player.name + ": 다음 던지기 무효 적용");
      window.dispatchEvent(new CustomEvent("ramyani-board:demoskip", {
        detail: {
          playerId: player.id,
          remainingSkipThrows: effects.skipNextThrows
        }
      }));
      await delay(500);
      return;
    }

    let shouldThrow = true;
    let throwIndex = 0;

    while (shouldThrow && throwIndex < DEMO_MAX_BONUS_CHAIN) {
      throwIndex += 1;

      // 먼저 논리 결과 전체를 확정한다. 화면 재생 중에는 지시문 판정을 다시 하지 않는다.
      const plan = resolveDemoThrowPlan(player, generator);
      await playDemoThrowPlan(player, plan);

      if (plan.safetyStopped) {
        setEventMessage(player.name + ": 지시문 연쇄 안전 제한 도달");
        return;
      }

      shouldThrow = plan.nextThrowScheduled;
      if (shouldThrow) {
        await delay(350);
      }
    }

    if (shouldThrow) {
      throw new Error("demo bonus chain safety limit reached");
    }
  }

  async function startDemo() {
    demoEffectStates.clear();
    seedDemoInstructions();
    seedDemoPlayers(DEMO_PLAYER_COUNT);
    setEventMessage(
      "통합 Throw Overlay " +
      board.columns + "×" + board.rows +
      " · 외곽 " + board.cellCount +
      "칸, 참가자 " + DEMO_PLAYER_COUNT + "명"
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
      } catch (error) {
        console.error("demo turn failed", error);
        setEventMessage(player.name + ": 데모 턴 복구 후 계속");
        // 데모는 한 턴 실패가 전체 루프를 중단시키지 않도록 다음 턴으로 계속 진행한다.
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

    const action = cell.action;
    if (action && typeof action === "object") {
      if (action.type === "move") {
        const resolved = Number(action.resolvedSteps);
        const fixed = Number(action.steps?.value);
        const steps = Number.isFinite(resolved) ? resolved : fixed;
        if (Number.isFinite(steps)) {
          return Math.abs(steps) + "칸 " +
            (action.direction === "backward" ? "뒤로" : "앞으로");
        }
      }
      if (action.type === "skipThrow") return "다음 던지기 무효";
      if (action.type === "multiplyNextThrow") {
        const multiplier = Math.max(2, Number(action.multiplier) || 2);
        return "다음 던지기 " + multiplier + "배";
      }
      if (action.type === "ignoreNextLanding") return "다음 칸 무효화";
      if (action.type === "moveToStart") return "START로 이동";
      if (action.type === "extraThrow") return "한 번 더";
    }

    if (cell.label) return cell.label;
    return cell.instructionId || "";
  }

  function roomCellInstructionType(cell) {
    if (!cell || cell.index === 0 || cell.type === "START") return "start";

    const action = cell.action;
    if (!action || typeof action !== "object") {
      return cell.type === "NORMAL" ? "normal" : "custom";
    }

    if (action.type === "move") {
      return action.direction === "backward" ? "backward" : "forward";
    }
    if (action.type === "skipThrow") return "skip";
    if (action.type === "multiplyNextThrow") return "multiplier";
    if (action.type === "ignoreNextLanding") return "ignore";
    if (action.type === "moveToStart") return "start-move";
    if (action.type === "extraThrow") return "extra";
    return cell.type === "NORMAL" ? "normal" : "custom";
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
      const target = configuredStyle === "rect"
        ? (INSTANT_MOVEMENT_MODE ? "rect-instant.html" : "rect.html")
        : (INSTANT_MOVEMENT_MODE ? "instant.html" : "index.html");
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
        kind: index === 0 ? "start" : (cell.type === "NORMAL" ? "normal" : "instruction"),
        instructionType: roomCellInstructionType(cell),
        randomCell: Boolean(cell.rerollOnVacate)
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
      ", 외곽 " + board.cellCount + "칸"
    );
    return snapshot;
  }

  function cellFromRuntimeState(cell) {
    return {
      label: roomCellLabel(cell),
      command: roomCellLabel(cell),
      kind: cell?.index === 0
        ? "start"
        : (cell?.type === "NORMAL" ? "normal" : "instruction"),
      instructionType: roomCellInstructionType(cell),
      randomCell: Boolean(cell?.rerollOnVacate)
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
    element.dataset.instructionType = definition.instructionType;
    element.dataset.randomCell = String(definition.randomCell);
    const label = element.querySelector(".cell-label");
    if (label) label.textContent = definition.command || definition.label;
  }

  async function playResolvedTurn(turn) {
    if (!turn || turn.type !== "board.turn" || String(turn.roomId) !== ROOM_ID) return;

    const playerId = String(turn.playerId || "");
    const player = state.players.get(playerId);
    if (!player) return;

    if (turn.openingThrowSkipped) {
      setEventMessage((turn.playerName || player.name) + ": 다음 던지기 무효");
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
