(() => {
  "use strict";

  const MIN_COLUMNS = 8;
  const MIN_ROWS = 6;
  const MAX_COLUMNS = 64;
  const MAX_ROWS = 48;
  const STEP_DELAY_MS = 220;
  const MAX_PLAYERS = 6;
  const MAX_VISIBLE_TOKENS = MAX_PLAYERS;

  const params = new URLSearchParams(window.location.search);
  const DEMO_MODE = params.get("demo") === "1";
  const DEMO_PLAYER_COUNT = Math.min(
    6,
    Math.max(1, Number.parseInt(params.get("players") || "3", 10) || 3)
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

  function range(start, count) {
    return Array.from({ length: count }, (_, offset) => start + offset);
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
  const edgeElements = new Map();

  let layoutFrame = 0;
  let typographyFrame = 0;

  function normalizeCell(index) {
    const numeric = Number.parseInt(index, 10);
    if (!Number.isFinite(numeric)) return 0;
    return ((numeric % board.cellCount) + board.cellCount) % board.cellCount;
  }

  function circularDistance(a, b) {
    const direct = Math.abs(a - b);
    return Math.min(direct, board.cellCount - direct);
  }

  function topology() {
    const top = range(0, board.columns);
    const right = range(board.columns, board.rows - 2);
    const bottomStart = board.columns + right.length;
    const bottom = range(bottomStart, board.columns);
    const left = range(bottomStart + bottom.length, board.rows - 2);

    return {
      top,
      right,
      bottom,
      left,
      topSpatial: top,
      rightSpatial: right,
      bottomSpatial: bottom.slice().reverse(),
      leftSpatial: left.slice().reverse()
    };
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

    refs.boardStage.dataset.layoutEngine = "flex-edge-v2";
    refs.boardStage.dataset.phase = state.currentPhaseId;
    refs.boardStage.dataset.totalLaps = String(state.totalLaps);
    refs.boardStage.dataset.playerCount = String(state.players.size);
    refs.boardStage.dataset.columns = String(board.columns);
    refs.boardStage.dataset.rows = String(board.rows);
    refs.boardStage.dataset.cellCount = String(board.cellCount);

    if (refs.boardGrid) {
      refs.boardGrid.setAttribute(
        "aria-label",
        board.columns + "×" + board.rows + " 외곽 " + board.cellCount + "칸 루프 보드"
      );
    }
  }

  function createCell(index, edgeName) {
    const definition = cellDefinition(index);
    const cell = document.createElement("article");

    cell.className = "board-cell";
    cell.dataset.cellIndex = String(index);
    cell.dataset.edge = edgeName;
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
    cellElements.set(index, cell);
    return cell;
  }

  function createEdge(name, indices) {
    const edge = document.createElement("div");
    edge.className = "board-edge board-edge-" + name;
    edge.dataset.edge = name;

    for (const index of indices) {
      edge.append(createCell(index, name));
    }

    refs.boardGrid.append(edge);
    edgeElements.set(name, edge);
  }

  function buildBoard() {
    if (!refs.boardGrid) return;

    refs.boardGrid.innerHTML = "";
    cellElements.clear();
    edgeElements.clear();

    const topo = topology();
    createEdge("top", topo.topSpatial);
    createEdge("right", topo.rightSpatial);
    createEdge("bottom", topo.bottomSpatial);
    createEdge("left", topo.leftSpatial);

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

  function scaleField() {
    const positions = Array.from(state.players.values(), (player) => player.position);

    if (!positions.length) {
      return Array.from({ length: board.cellCount }, () => 1);
    }

    // 최대 6명 기준: 참가자 수에 따른 전역 감쇠 없이
    // 가장 가까운 참가자의 국소 영향만 사용한다.
    const restScale = 0.82;
    const peakScale = 1.55;
    const sigma = 1.15;
    const influenceRadius = 3;

    return Array.from({ length: board.cellCount }, (_, cellIndex) => {
      let influence = 0;

      for (const position of positions) {
        const distance = circularDistance(cellIndex, position);
        if (distance > influenceRadius) continue;

        influence = Math.max(
          influence,
          Math.exp(-0.5 * Math.pow(distance / sigma, 2))
        );
      }

      return restScale + ((peakScale - restScale) * influence);
    });
  }

  function setCellLayout(index, scale, occupied) {
    const cell = cellElements.get(index);
    if (!cell) return;

    // Main-axis share and cross-axis size are driven by the same scale.
    // With a fixed aspect-ratio this makes every cell grow/shrink uniformly
    // in both width and height instead of stretching along one axis.
    cell.style.flexGrow = scale.toFixed(4);
    cell.style.width = "";
    cell.style.height = "";
    cell.style.setProperty("--dock-scale", scale.toFixed(3));
    cell.style.zIndex = String(Math.round(scale * 100) + (occupied ? 200 : 0));
    cell.dataset.occupied = String(occupied);
    cell.dataset.dockScale = scale.toFixed(3);
  }

  function updateTypography() {
    typographyFrame = 0;
    const measurements = [];

    cellElements.forEach((cell, index) => {
      const rect = cell.getBoundingClientRect();
      measurements.push({
        index,
        width: rect.width,
        height: rect.height
      });
    });

    for (const item of measurements) {
      const cell = cellElements.get(item.index);
      if (!cell || item.width <= 0 || item.height <= 0) continue;

      const typographyBasis = Math.sqrt(item.width * item.height);
      const tokenBasis = Math.min(item.width, item.height);
      const indexFontSize = clamp(typographyBasis * 0.135, 8, 16);
      const labelFontSize = clamp(typographyBasis * 0.105, 7, 14);
      const tokenSize = clamp(tokenBasis * 0.42, 18, 58);
      const tokenFontSize = clamp(tokenSize * 0.34, 8, 15);

      cell.style.setProperty("--cell-index-font", indexFontSize.toFixed(3) + "px");
      cell.style.setProperty("--cell-label-font", labelFontSize.toFixed(3) + "px");
      cell.style.setProperty("--cell-token-size", tokenSize.toFixed(3) + "px");
      cell.style.setProperty("--cell-token-font", tokenFontSize.toFixed(3) + "px");
    }
  }

  function scheduleTypography() {
    if (typographyFrame) return;
    typographyFrame = window.requestAnimationFrame(updateTypography);
  }

  function layoutNow() {
    layoutFrame = 0;
    if (!refs.boardStage || !refs.boardGrid || !cellElements.size) return;

    const rect = refs.boardStage.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) return;

    const topo = topology();
    const scales = scaleField();
    const occupancy = occupancyByCell();

    const inset = clamp(Math.min(width, height) * 0.014, 8, 22);
    const nominalWidth = Math.max(1, (width - (inset * 2)) / board.columns);
    const nominalHeight = Math.max(1, (height - (inset * 2)) / board.rows);
    const nominalCell = Math.min(nominalWidth, nominalHeight);
    const gap = clamp(nominalCell * 0.075, 2, 12);

    const usableWidth = Math.max(
      1,
      width - (inset * 2) - (gap * (board.columns - 1))
    );
    const usableHeight = Math.max(
      1,
      height - (inset * 2) - (gap * (board.rows - 1))
    );
    const baseWidth = usableWidth / board.columns;
    const baseHeight = usableHeight / board.rows;
    const cellAspect = baseWidth / Math.max(1, baseHeight);

    for (let index = 0; index < board.cellCount; index += 1) {
      setCellLayout(index, scales[index], occupancy.has(index));
    }

    function horizontalBand(indices) {
      const available = Math.max(
        1,
        width - (inset * 2) - (gap * Math.max(0, indices.length - 1))
      );
      const weightTotal = indices.reduce((sum, index) => sum + scales[index], 0);
      const maxMain = indices.reduce((max, index) => {
        const size = available * (scales[index] / Math.max(0.0001, weightTotal));
        return Math.max(max, size);
      }, 1);
      return maxMain / Math.max(0.01, cellAspect);
    }

    const topBand = horizontalBand(topo.topSpatial);
    const bottomBand = horizontalBand(topo.bottomSpatial);
    const sideHeight = Math.max(
      1,
      height - (inset * 2) - topBand - bottomBand - (gap * 2)
    );

    function verticalBand(indices) {
      const available = Math.max(
        1,
        sideHeight - (gap * Math.max(0, indices.length - 1))
      );
      const weightTotal = indices.reduce((sum, index) => sum + scales[index], 0);
      const maxMain = indices.reduce((max, index) => {
        const size = available * (scales[index] / Math.max(0.0001, weightTotal));
        return Math.max(max, size);
      }, 1);
      return maxMain * cellAspect;
    }

    const rightBand = verticalBand(topo.rightSpatial);
    const leftBand = verticalBand(topo.leftSpatial);

    refs.boardGrid.style.setProperty("--board-inset", inset.toFixed(3) + "px");
    refs.boardGrid.style.setProperty("--board-gap", gap.toFixed(3) + "px");
    refs.boardGrid.style.setProperty("--cell-aspect", cellAspect.toFixed(6));
    refs.boardGrid.style.setProperty("--top-band", topBand.toFixed(3) + "px");
    refs.boardGrid.style.setProperty("--bottom-band", bottomBand.toFixed(3) + "px");
    refs.boardGrid.style.setProperty("--right-band", rightBand.toFixed(3) + "px");
    refs.boardGrid.style.setProperty("--left-band", leftBand.toFixed(3) + "px");

    scheduleTypography();
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

      if (players.length <= MAX_VISIBLE_TOKENS) {
        for (const player of players) stack.append(createPlayerToken(player));
      } else {
        for (const player of players.slice(0, MAX_VISIBLE_TOKENS - 1)) {
          stack.append(createPlayerToken(player));
        }

        const countToken = document.createElement("span");
        countToken.className = "player-token player-token-count";
        countToken.title = players.length + "명 위치";
        countToken.textContent = "+" + (players.length - (MAX_VISIBLE_TOKENS - 1));
        stack.append(countToken);
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
      shortLabel: String(
        (input && input.shortLabel) || name.slice(0, 2)
      ).trim() || "P",
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
      "Flex Edge v2 데모 · " +
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
