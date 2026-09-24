(() => {
  "use strict";

  const BOARD_COLUMNS = 8;
  const BOARD_ROWS = 6;
  const CELL_COUNT = 24;
  const STEP_DELAY_MS = 220;
  const params = new URLSearchParams(window.location.search);
  const DEMO_MODE = params.get("demo") === "1";
  const DEMO_PLAYER_COUNT = Math.min(12, Math.max(1, Number.parseInt(params.get("players") || "3", 10) || 3));

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

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeCell(index) {
    const numeric = Number.parseInt(index, 10);
    if (!Number.isFinite(numeric)) return 0;
    return ((numeric % CELL_COUNT) + CELL_COUNT) % CELL_COUNT;
  }

  function circularDistance(a, b) {
    const direct = Math.abs(a - b);
    return Math.min(direct, CELL_COUNT - direct);
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
  }

  function buildBoard() {
    if (!refs.boardGrid) return;

    refs.boardGrid.innerHTML = "";
    cellElements.clear();

    for (let index = 0; index < CELL_COUNT; index += 1) {
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
      return Array.from({ length: CELL_COUNT }, () => 1);
    }

    const playerCount = playerPositions.length;
    const intensity = clamp(1 / Math.sqrt(Math.max(1, playerCount) * 0.72), 0.42, 1);
    const restScale = 0.78 + ((1 - intensity) * 0.12);
    const peakRange = 0.72 * intensity;
    const proximityProfile = [1, 0.58, 0.30];

    return Array.from({ length: CELL_COUNT }, (_, cellIndex) => {
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
        ? Math.min(0.10, Math.log2(exactOccupancy) * 0.035 * intensity)
        : 0;

      return clamp(restScale + (peakRange * combinedInfluence) + occupancyBoost, 0.72, 1.56);
    });
  }

  function layoutLinear(indices, sizes, availableStart, availableEnd, minGap) {
    const available = Math.max(1, availableEnd - availableStart);
    const desired = indices.map((index) => Math.max(1, sizes.get(index) || 1));
    const minimumGapTotal = minGap * Math.max(0, indices.length - 1);
    const maxSizeTotal = Math.max(1, available - minimumGapTotal);
    const desiredTotal = desired.reduce((sum, value) => sum + value, 0);
    const compression = desiredTotal > maxSizeTotal ? maxSizeTotal / desiredTotal : 1;
    const fitted = desired.map((value) => value * compression);
    const fittedTotal = fitted.reduce((sum, value) => sum + value, 0);
    const gap = indices.length > 1
      ? Math.max(minGap, (available - fittedTotal) / (indices.length - 1))
      : 0;

    let cursor = availableStart;
    const centers = new Map();

    indices.forEach((index, order) => {
      const size = fitted[order];
      const center = cursor + (size / 2);
      centers.set(index, { center, size });
      cursor += size + gap;
    });

    return centers;
  }

  function layoutBoardCells() {
    if (!refs.boardStage || !cellElements.size) return;

    const rect = refs.boardStage.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) return;

    const inset = clamp(width * 0.0105, 10, 22);
    const minGap = clamp(width * 0.0048, 6, 12);
    const baseWidth = Math.max(1, (width - (inset * 2) - (minGap * 7)) / BOARD_COLUMNS);
    const baseHeight = Math.max(1, (height - (inset * 2) - (minGap * 5)) / BOARD_ROWS);
    const scales = dockScales();
    const occupancy = occupancyByCell();

    const widths = new Map();
    const heights = new Map();

    for (let index = 0; index < CELL_COUNT; index += 1) {
      const scale = scales[index];
      widths.set(index, baseWidth * scale);
      heights.set(index, baseHeight * scale);
    }

    const top = [0, 1, 2, 3, 4, 5, 6, 7];
    const right = [8, 9, 10, 11];
    const bottom = [19, 18, 17, 16, 15, 14, 13, 12];
    const left = [23, 22, 21, 20];

    const topX = layoutLinear(top, widths, inset, width - inset, minGap);
    const bottomX = layoutLinear(bottom, widths, inset, width - inset, minGap);

    const maxTopHeight = Math.max(...top.map((index) => heights.get(index)));
    const maxBottomHeight = Math.max(...bottom.map((index) => heights.get(index)));
    const sideStart = inset + maxTopHeight + minGap;
    const sideEnd = height - inset - maxBottomHeight - minGap;

    const rightY = layoutLinear(right, heights, sideStart, sideEnd, minGap);
    const leftY = layoutLinear(left, heights, sideStart, sideEnd, minGap);

    function apply(index, x, y, fittedWidth, fittedHeight) {
      const cell = cellElements.get(index);
      if (!cell) return;

      const scale = scales[index];
      const isOccupied = occupancy.has(index);
      cell.style.left = `${x}px`;
      cell.style.top = `${y}px`;
      cell.style.width = `${Math.max(1, fittedWidth)}px`;
      cell.style.height = `${Math.max(1, fittedHeight)}px`;
      cell.style.setProperty("--dock-scale", scale.toFixed(3));
      cell.style.zIndex = String(Math.round(scale * 100) + (isOccupied ? 200 : 0));
      cell.dataset.occupied = String(isOccupied);
      cell.dataset.dockScale = scale.toFixed(3);
    }

    for (const index of top) {
      const item = topX.get(index);
      apply(index, item.center, inset + (heights.get(index) / 2), item.size, heights.get(index));
    }

    for (const index of bottom) {
      const item = bottomX.get(index);
      apply(index, item.center, height - inset - (heights.get(index) / 2), item.size, heights.get(index));
    }

    for (const index of right) {
      const item = rightY.get(index);
      apply(index, width - inset - (widths.get(index) / 2), item.center, widths.get(index), item.size);
    }

    for (const index of left) {
      const item = leftY.get(index);
      apply(index, inset + (widths.get(index) / 2), item.center, widths.get(index), item.size);
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

      if (previous === CELL_COUNT - 1 && player.position === 0) {
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
      dimensions: {
        columns: BOARD_COLUMNS,
        rows: BOARD_ROWS,
        cells: CELL_COUNT
      },
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
        position: Math.floor((index * CELL_COUNT) / count)
      });
    }
  }

  function startDemo() {
    seedDemoPlayers(DEMO_PLAYER_COUNT);
    setEventMessage(`Dock 강조 데모 · 참가자 ${DEMO_PLAYER_COUNT}명`);

    window.setInterval(() => {
      const players = Array.from(state.players.values());
      if (!players.length) return;

      const player = players[Math.floor(Math.random() * players.length)];
      const dice = 1 + Math.floor(Math.random() * 6);
      enqueueRoll(player.id, dice, { source: "데모" }).catch(() => undefined);
    }, 2100);
  }

  window.RamyaniBoard = Object.freeze({
    BOARD_COLUMNS,
    BOARD_ROWS,
    CELL_COUNT,
    registerPlayer,
    removePlayer,
    enqueueRoll,
    setPhasePlan,
    getSnapshot,
    layoutBoardCells
  });

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
    setEventMessage("24칸 방송 오버레이 준비 완료");
  }
})();
