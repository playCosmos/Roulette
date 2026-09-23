(() => {
  "use strict";

  const BOARD_COLUMNS = 8;
  const BOARD_ROWS = 6;
  const CELL_COUNT = 24;
  const STEP_DELAY_MS = 220;
  const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "1";

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

  function perimeterPosition(index) {
    if (index < 8) return { row: 1, column: index + 1 };
    if (index < 12) return { row: index - 6, column: 8 };
    if (index < 20) return { row: 6, column: 20 - index };
    return { row: 25 - index, column: 1 };
  }

  function normalizeCell(index) {
    const numeric = Number.parseInt(index, 10);
    if (!Number.isFinite(numeric)) return 0;
    return ((numeric % CELL_COUNT) + CELL_COUNT) % CELL_COUNT;
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
      const { row, column } = perimeterPosition(index);
      const definition = cellDefinition(index);

      const cell = document.createElement("article");
      cell.className = "board-cell";
      cell.dataset.cellIndex = String(index);
      cell.dataset.kind = definition.kind;
      cell.style.gridRow = String(row);
      cell.style.gridColumn = String(column);

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

    const normalized = plan
      .map((phase, index) => ({
        id: String(phase.id || `phase-${index + 1}`),
        minTotalLaps: Math.max(0, Number.parseInt(phase.minTotalLaps ?? 0, 10) || 0),
        label: String(phase.label || `PHASE ${index + 1}`),
        description: String(phase.description || ""),
        cells: phase.cells && typeof phase.cells === "object" ? phase.cells : {}
      }))
      .sort((a, b) => a.minTotalLaps - b.minTotalLaps);

    state.phasePlan = normalized;
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

  function seedDemoPlayers() {
    registerPlayer({ id: "player-a", name: "참가자 A", shortLabel: "A", position: 0 });
    registerPlayer({ id: "player-b", name: "참가자 B", shortLabel: "B", position: 5 });
    registerPlayer({ id: "player-c", name: "참가자 C", shortLabel: "C", position: 14 });
  }

  function startDemo() {
    seedDemoPlayers();
    setEventMessage("오버레이 이동 데모 실행 중");

    window.setInterval(() => {
      const players = Array.from(state.players.values());
      if (!players.length) return;
      const player = players[Math.floor(Math.random() * players.length)];
      const dice = 1 + Math.floor(Math.random() * 6);
      enqueueRoll(player.id, dice, { source: "데모" }).catch(() => undefined);
    }, 2200);
  }

  window.RamyaniBoard = Object.freeze({
    BOARD_COLUMNS,
    BOARD_ROWS,
    CELL_COUNT,
    registerPlayer,
    removePlayer,
    enqueueRoll,
    setPhasePlan,
    getSnapshot
  });

  buildBoard();
  renderGlobalState();

  if (DEMO_MODE) {
    startDemo();
  } else {
    setEventMessage("24칸 방송 오버레이 준비 완료");
  }
})();
