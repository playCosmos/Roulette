(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("boardRoomForm");
  if (!form) return;

  const playersRoot = $("boardRoomPlayers");
  const addPlayerButton = $("boardRoomAddPlayer");
  const playerLimitState = $("boardRoomPlayerLimitState");
  const sizingMode = $("boardRoomSizingMode");
  const dimensionsFields = $("boardRoomDimensionsFields");
  const cellCountField = $("boardRoomCellCountField");
  const diceEnabled = $("boardRoomDiceEnabled");
  const yutEnabled = $("boardRoomYutEnabled");
  const diceFields = $("boardRoomDiceFields");
  const yutFields = $("boardRoomYutFields");
  const instructionRows = $("boardRoomInstructionRows");
  const instructionList = $("boardRoomInstructionList");
  const instructionEmptyState = $("boardRoomInstructionEmptyState");
  const randomPoolMode = $("boardRoomRandomPoolMode");
  const result = $("boardRoomResult");
  const liveSummary = $("boardRoomLiveSummary");
  const previewPanel = $("boardRoomPreviewPanel");
  const previewFrame = $("boardRoomPreviewFrame");
  const previewMeta = $("boardRoomPreviewMeta");
  const rerollButton = $("boardRoomRerollButton");
  const commitButton = $("boardRoomCommitButton");
  const pauseButton = $("boardRoomPauseButton");
  const resumeButton = $("boardRoomResumeButton");
  const terminateButton = $("boardRoomTerminateButton");
  const extendControl = $("boardRoomExtendControl");
  const extendMinutes = $("boardRoomExtendMinutes");
  const extendButton = $("boardRoomExtendButton");
  const createButton = $("boardRoomCreateButton");
  const overlayRow = $("boardRoomOverlayRow");
  const overlayUrl = $("boardRoomOverlayUrl");
  const copyOverlayButton = $("boardRoomCopyOverlayButton");
  const openOverlayButton = $("boardRoomOpenOverlayButton");
  const bridgeOverlayUrl = $("overlayUrlInput");

  let currentRoom = null;
  let instructionSequence = 0;
  let instructionEditorSequence = 0;
  let selectedInstructionRow = null;

  function showResult(text, tone = "") {
    result.textContent = text;
    result.className = "operation-result" + (tone ? " " + tone : "");
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "Accept": "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      },
      ...options
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = { error: text }; }
    }
    if (!response.ok) {
      const details = Array.isArray(payload.details)
        ? payload.details.map((item) => item.field + ": " + item.message).join(" / ")
        : "";
      throw new Error((payload.error || response.status + " " + response.statusText) + (details ? ": " + details : ""));
    }
    return payload;
  }

  function playerRows() {
    return Array.from(
      playersRoot.querySelectorAll(".board-room-player-row")
    );
  }

  function sharedBalloonCheckbox() {
    return playersRoot.querySelector(
      "#boardRoomSharedBalloonEnabled"
    );
  }

  function p1BalloonInput() {
    return playersRoot.querySelector(
      '.board-room-player-row [data-field="balloonTrigger"]'
    );
  }

  function syncPlayerLimitState() {
    const count = playerRows().length;
    if (playerLimitState) {
      playerLimitState.textContent = count + " / 6명";
    }
    if (addPlayerButton) {
      addPlayerButton.disabled = count >= 6;
      addPlayerButton.title = count >= 6
        ? "참가자는 최대 6명까지 추가할 수 있습니다."
        : "";
    }
  }

  function syncSharedBalloonMode() {
    const checkbox = sharedBalloonCheckbox();
    const shared = checkbox?.checked === true;
    const rows = playerRows();
    const source = rows[0]?.querySelector(
      '[data-field="balloonTrigger"]'
    );
    const sourceValue = source?.value || "100";

    rows.forEach((row, index) => {
      const input = row.querySelector(
        '[data-field="balloonTrigger"]'
      );
      if (!input) return;
      if (shared && index > 0) {
        input.value = sourceValue;
        input.disabled = true;
        input.title = "P1의 ‘모두 동일’ 설정을 사용 중입니다.";
      } else {
        input.disabled = false;
        input.title = "";
      }
    });
  }

  function renumberPlayers(sharedOverride) {
    const previousShared =
      typeof sharedOverride === "boolean"
        ? sharedOverride
        : (sharedBalloonCheckbox()?.checked ?? true);

    playerRows().forEach((row, index) => {
      const indexNode = row.querySelector(
        ".board-room-player-index"
      );
      if (indexNode) indexNode.textContent = "P" + (index + 1);

      const triggerLabel = row.querySelector(
        "[data-balloon-label]"
      );
      if (!triggerLabel) return;

      if (index === 0) {
        triggerLabel.innerHTML = `
          <span>턴 실행 별풍선</span>
          <span class="board-room-shared-balloon-toggle">
            <input id="boardRoomSharedBalloonEnabled" type="checkbox" ${previousShared ? "checked" : ""} />
            모두 동일
          </span>
        `;
      } else {
        triggerLabel.textContent = "턴 실행 별풍선";
      }
    });
    syncPlayerLimitState();
    syncSharedBalloonMode();
  }

  function addPlayerRow(initial = {}) {
    if (playerRows().length >= 6) return;

    const row = document.createElement("div");
    row.className = "board-room-player-row";
    row.innerHTML = `
      <button type="button" class="board-room-player-remove" data-remove-player aria-label="참가자 삭제">삭제</button>
      <span class="board-room-player-index"></span>
      <label>SOOP ID
        <input data-field="soopId" autocomplete="off" maxlength="120" required value="${escapeAttribute(initial.soopId || "")}" />
      </label>
      <label>표시 이름
        <input data-field="displayName" autocomplete="off" maxlength="80" value="${escapeAttribute(initial.displayName || "")}" placeholder="미입력 시 SOOP 현재 닉네임" />
      </label>
      <label class="board-room-balloon-field">
        <span class="board-room-balloon-label" data-balloon-label>턴 실행 별풍선</span>
        <input data-field="balloonTrigger" type="number" min="1" step="1" required value="${escapeAttribute(initial.balloonTrigger || "100")}" />
      </label>
      <span class="board-room-inline-status" data-live-status>생성 시 확인</span>
    `;
    playersRoot.append(row);
    renumberPlayers();
  }

  function resetSinglePlayer(row) {
    const soopId = row.querySelector('[data-field="soopId"]');
    const displayName = row.querySelector(
      '[data-field="displayName"]'
    );
    const balloonTrigger = row.querySelector(
      '[data-field="balloonTrigger"]'
    );
    const liveStatus = row.querySelector("[data-live-status]");

    if (soopId) soopId.value = "";
    if (displayName) displayName.value = "";
    if (balloonTrigger) balloonTrigger.value = "100";
    if (liveStatus) {
      liveStatus.textContent = "생성 시 확인";
      liveStatus.removeAttribute("data-status");
    }

    const checkbox = sharedBalloonCheckbox();
    if (checkbox) checkbox.checked = true;
    syncSharedBalloonMode();
    soopId?.focus();
  }

  function removePlayerRow(row) {
    const rows = playerRows();
    if (rows.length <= 1) {
      resetSinglePlayer(row);
      return;
    }
    const shared = sharedBalloonCheckbox()?.checked ?? true;
    row.remove();
    renumberPlayers(shared);
  }

  function renderPlayers() {
    playersRoot.innerHTML = "";
    for (let index = 0; index < 4; index += 1) {
      addPlayerRow();
    }
  }

  function escapeAttribute(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function normalizeInstructionId(value, fallback) {
    const clean = String(value || fallback)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return clean || ("CUSTOM_" + (++instructionSequence));
  }

  function uniqueInstructionId(base) {
    const ids = new Set(
      Array.from(instructionRows.querySelectorAll('[data-field="instructionId"]'))
        .map((input) => input.value.trim().toUpperCase())
    );
    let candidate = normalizeInstructionId(base, "CUSTOM");
    let suffix = 2;
    while (ids.has(candidate)) candidate = normalizeInstructionId(base, "CUSTOM") + "_" + suffix++;
    return candidate;
  }

  function instructionTitle(row) {
    const label = row.querySelector('[data-field="label"]')?.value?.trim();
    const id = row.querySelector('[data-field="instructionId"]')?.value?.trim();
    return {
      label: label || id || "새 지시문",
      id: id || "UNNAMED"
    };
  }

  function selectInstruction(row) {
    selectedInstructionRow = row && row.isConnected ? row : null;
    instructionRows.querySelectorAll(".board-room-instruction-row").forEach((candidate) => {
      candidate.hidden = candidate !== selectedInstructionRow;
    });
    if (instructionEmptyState) {
      instructionEmptyState.hidden = selectedInstructionRow !== null;
    }
    if (instructionList) {
      instructionList.querySelectorAll("[data-instruction-key]").forEach((button) => {
        button.classList.toggle(
          "active",
          selectedInstructionRow !== null &&
          button.dataset.instructionKey === selectedInstructionRow.dataset.editorKey
        );
      });
    }
  }

  function updateInstructionListItem(row) {
    if (!instructionList || !row?.dataset?.editorKey) return;
    const item = Array.from(
      instructionList.querySelectorAll("[data-instruction-key]")
    ).find((candidate) => candidate.dataset.instructionKey === row.dataset.editorKey);
    if (!item) return;
    const title = instructionTitle(row);
    const label = item.querySelector("[data-list-label]");
    const id = item.querySelector("[data-list-id]");
    const enabled = row.dataset.enabled !== "false";
    item.classList.toggle("disabled", !enabled);
    const toggle = item.querySelector(".board-room-instruction-enabled");
    if (toggle) toggle.checked = enabled;
    if (label) label.textContent = title.label;
    if (id) id.textContent = title.id;
  }

  function setInstructionEnabled(row, enabled) {
    row.dataset.enabled = enabled ? "true" : "false";
    row.classList.toggle("disabled", !enabled);
    updateInstructionListItem(row);
  }

  function rebuildInstructionList() {
    if (!instructionList) return;
    instructionList.innerHTML = "";
    const rows = Array.from(
      instructionRows.querySelectorAll(".board-room-instruction-row")
    );

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "board-room-instruction-list-empty";
      empty.textContent = "지시문이 없습니다.";
      instructionList.append(empty);
      selectInstruction(null);
      return;
    }

    rows.forEach((row) => {
      if (!row.dataset.editorKey) {
        row.dataset.editorKey = "instruction-" + (++instructionEditorSequence);
      }
      const title = instructionTitle(row);
      const item = document.createElement("div");
      item.className = "board-room-instruction-list-item";
      item.dataset.instructionKey = row.dataset.editorKey;

      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.className = "board-room-instruction-enabled";
      enabled.checked = row.dataset.enabled !== "false";
      enabled.title = "활성 / 비활성";
      enabled.addEventListener("change", () => {
        setInstructionEnabled(row, enabled.checked);
      });

      const select = document.createElement("button");
      select.type = "button";
      select.className = "board-room-instruction-select";

      const label = document.createElement("strong");
      label.dataset.listLabel = "";
      label.textContent = title.label;

      const id = document.createElement("span");
      id.dataset.listId = "";
      id.textContent = title.id;

      select.append(label, id);
      select.addEventListener("click", () => selectInstruction(row));
      item.append(enabled, select);
      instructionList.append(item);
    });

    if (!selectedInstructionRow || !selectedInstructionRow.isConnected) {
      selectInstruction(rows[0]);
    } else {
      selectInstruction(selectedInstructionRow);
    }
  }

  function addInstruction(kind, options = {}) {
    const presets = {
      forward: {
        id: "MOVE_FORWARD",
        label: "{n}칸 앞으로",
        action: "move",
        direction: "forward",
        allocationMode: "ratio",
        allocationValue: 10
      },
      backward: {
        id: "MOVE_BACKWARD",
        label: "{n}칸 뒤로",
        action: "move",
        direction: "backward",
        allocationMode: "ratio",
        allocationValue: 10
      },
      skip: {
        id: "SKIP_NEXT_THROW",
        label: "다음 주사위 무효",
        action: "skipThrow",
        allocationMode: "count",
        allocationValue: 1
      },
      multiplier: {
        id: "MULTIPLY_NEXT_THROW",
        label: "다음 주사위 {m}배",
        action: "multiplyNextThrow",
        allocationMode: "count",
        allocationValue: 1
      },
      ignoreLanding: {
        id: "IGNORE_NEXT_LANDING",
        label: "다음 칸 무효화",
        action: "ignoreNextLanding",
        allocationMode: "count",
        allocationValue: 1
      },
      custom: {
        id: "CUSTOM",
        label: "사용자 지시문",
        action: "display",
        allocationMode: "count",
        allocationValue: 1
      }
    };

    const preset = presets[kind] || presets.custom;
    const builtIn = Boolean(options.builtIn);
    const id = uniqueInstructionId(preset.id);
    const row = document.createElement("div");
    row.className = "board-room-instruction-row";
    row.dataset.editorKey = "instruction-" + (++instructionEditorSequence);
    row.dataset.actionType = preset.action;
    row.dataset.randomPlaceholder = "false";
    row.dataset.builtIn = builtIn ? "true" : "false";
    row.dataset.enabled = "true";
    row.innerHTML = `
      <div class="board-room-instruction-head">
        <div>
          <strong>${escapeAttribute(preset.label)}</strong>
          ${builtIn ? '<span class="board-room-built-in-badge">기본</span>' : ""}
        </div>
        <button type="button" class="board-room-small-button" data-action="remove" ${builtIn ? "hidden" : ""}>삭제</button>
      </div>
      <div class="board-room-instruction-grid">
        <label>ID
          <input data-field="instructionId" value="${escapeAttribute(id)}" maxlength="80" required ${builtIn ? "readonly" : ""} />
        </label>
        <label>표시 문구
          <input data-field="label" value="${escapeAttribute(preset.label)}" maxlength="120" required />
        </label>
        <label>배치 방식
          <select data-field="allocationMode">
            <option value="ratio" ${preset.allocationMode === "ratio" ? "selected" : ""}>비율</option>
            <option value="count" ${preset.allocationMode === "count" ? "selected" : ""}>수량</option>
          </select>
        </label>
        <label>배치 값
          <input data-field="allocationValue" type="number" min="0" max="100" step="1" value="${preset.allocationValue}" required />
        </label>
      </div>
      <div class="board-room-instruction-options">
        <label class="check-label"><input data-field="poolEnabled" type="checkbox" />랜덤 후보에 포함</label>
        <label class="pool-weight">랜덤 가중치
          <input data-field="poolWeight" type="number" min="0.0001" step="0.1" value="${preset.allocationValue}" />
        </label>
      </div>
      <div class="board-room-action-options"></div>
    `;

    instructionRows.append(row);
    renderActionOptions(row, preset);
    syncInstructionRow(row);

    if (!options.deferList) {
      rebuildInstructionList();
      selectInstruction(row);
    }

    return row;
  }

  function seedDefaultInstructions() {
    if (instructionRows.querySelector(".board-room-instruction-row")) return;
    ["forward", "backward", "skip", "multiplier", "ignoreLanding"].forEach((kind) => {
      addInstruction(kind, { builtIn: true, deferList: true });
    });
    rebuildInstructionList();
    selectInstruction(
      instructionRows.querySelector(".board-room-instruction-row")
    );
  }

  function renderActionOptions(row, preset) {
    const root = row.querySelector(".board-room-action-options");
    if (preset.action === "move") {
      root.innerHTML = `
        <span class="board-room-action-chip">${preset.direction === "backward" ? "{n}칸 뒤로" : "{n}칸 앞으로"}</span>
        <label>{n} 설정
          <select data-field="stepsMode">
            <option value="fixed">고정</option>
            <option value="range">범위 랜덤</option>
          </select>
        </label>
        <label data-fixed-steps>{n}
          <input data-field="stepsValue" type="number" min="1" max="999" step="1" value="1" />
        </label>
        <label data-range-min hidden>최소
          <input data-field="stepsMin" type="number" min="1" max="999" step="1" value="1" />
        </label>
        <label data-range-max hidden>최대
          <input data-field="stepsMax" type="number" min="1" max="999" step="1" value="4" />
        </label>
      `;
      row.dataset.direction = preset.direction;
    } else if (preset.action === "moveToStart") {
      root.innerHTML = '<span class="board-room-action-chip">도착 즉시 START로 이동</span>';
    } else if (preset.action === "skipThrow") {
      root.innerHTML = '<span class="board-room-action-chip">가장 가까운 다음 던지기 1회 무효</span>';
    } else if (preset.action === "multiplyNextThrow") {
      root.innerHTML = `
        <span class="board-room-action-chip">다음 던지기 이동값 배율</span>
        <label>{m}
          <input data-field="multiplierValue" type="number" min="2" max="100" step="1" value="2" />
        </label>
      `;
    } else if (preset.action === "ignoreNextLanding") {
      root.innerHTML = '<span class="board-room-action-chip">다음 칸 지시문을 1회 무효화</span>';
    } else if (preset.action === "randomCell") {
      root.innerHTML = '<span class="board-room-action-chip">랜덤 후보 풀에서 최초/재선정 (수량 배치만 가능)</span>';
    } else {
      root.innerHTML = '<span class="board-room-action-chip">표시/사용자 지시문</span>';
    }
  }

  function syncInstructionRow(row) {
    const allocationMode = row.querySelector('[data-field="allocationMode"]');
    const randomCell = row.dataset.randomPlaceholder === "true";

    if (randomCell) {
      allocationMode.value = "count";
      allocationMode.disabled = true;
    } else {
      allocationMode.disabled = false;
    }

    const mode = allocationMode.value;
    const value = row.querySelector('[data-field="allocationValue"]');
    value.max = mode === "ratio" ? "100" : "999";
    value.step = "1";

    const poolEnabled = row.querySelector('[data-field="poolEnabled"]');
    const poolWeight = row.querySelector('[data-field="poolWeight"]');
    const inherited = randomPoolMode.value === "inheritRatioInstructions";

    if (randomCell) {
      poolEnabled.checked = false;
      poolEnabled.disabled = true;
      poolWeight.value = "0";
      poolWeight.disabled = true;
    } else if (inherited) {
      poolEnabled.checked = mode === "ratio" && Number(value.value) > 0;
      poolEnabled.disabled = true;
      poolWeight.value = mode === "ratio" ? value.value : "0";
      poolWeight.disabled = true;
    } else {
      poolEnabled.disabled = false;
      poolWeight.disabled = !poolEnabled.checked;
    }

    const stepsMode = row.querySelector('[data-field="stepsMode"]');
    if (stepsMode) {
      const range = stepsMode.value === "range";
      row.querySelector("[data-fixed-steps]").hidden = range;
      row.querySelector("[data-range-min]").hidden = !range;
      row.querySelector("[data-range-max]").hidden = !range;
    }

    updateInstructionListItem(row);
  }

  function syncAllInstructionRows() {
    instructionRows.querySelectorAll(".board-room-instruction-row").forEach(syncInstructionRow);
  }

  function syncBoardSizing() {
    const cellMode = sizingMode.value === "cellCount";
    dimensionsFields.hidden = cellMode;
    cellCountField.hidden = !cellMode;
  }

  function syncMovement() {
    diceFields.hidden = !diceEnabled.checked;
    yutFields.hidden = !yutEnabled.checked;
  }

  function selectedMovementGenerator() {
    const dice = diceEnabled.checked;
    const yut = yutEnabled.checked;
    if (dice && yut) return "mixed";
    if (dice) return "dice";
    if (yut) return "yut";
    throw new Error("주사위 또는 윷 중 하나 이상 활성화하세요.");
  }

  function syncPauseDonationPolicy() {
    const mode = form.elements.namedItem("pauseDonationMode")?.value || "QUEUE";
    const grace = form.elements.namedItem("pauseGraceSeconds");
    if (!grace) return;
    grace.disabled = mode === "IGNORE";
    grace.title = mode === "IGNORE"
      ? "즉시 무시 모드에서는 유예시간을 사용하지 않습니다."
      : "일시정지 후 이 시간 동안 들어온 후원만 큐에 저장합니다.";
  }

  function collectPlayers() {
    return Array.from(playersRoot.querySelectorAll(".board-room-player-row")).map((row) => ({
      soopId: row.querySelector('[data-field="soopId"]').value.trim(),
      displayName: row.querySelector('[data-field="displayName"]').value.trim(),
      profileImageUrl: null,
      balloonTrigger: Number(row.querySelector('[data-field="balloonTrigger"]').value)
    }));
  }

  function collectInstruction(row) {
    const id = normalizeInstructionId(row.querySelector('[data-field="instructionId"]').value, "CUSTOM");
    row.querySelector('[data-field="instructionId"]').value = id;

    const label = row.querySelector('[data-field="label"]').value.trim() || id;
    const allocationMode = row.querySelector('[data-field="allocationMode"]').value;
    const allocationValue = Number(row.querySelector('[data-field="allocationValue"]').value);
    const actionType = row.dataset.actionType;

    let action;
    if (actionType === "move") {
      const stepsMode = row.querySelector('[data-field="stepsMode"]').value;
      action = {
        type: "move",
        direction: row.dataset.direction,
        steps: stepsMode === "range"
          ? {
              mode: "range",
              min: Number(row.querySelector('[data-field="stepsMin"]').value),
              max: Number(row.querySelector('[data-field="stepsMax"]').value)
            }
          : {
              mode: "fixed",
              value: Number(row.querySelector('[data-field="stepsValue"]').value)
            }
      };
    } else if (actionType === "moveToStart") {
      action = { type: "moveToStart" };
    } else if (actionType === "skipThrow") {
      action = { type: "skipThrow", count: 1 };
    } else if (actionType === "multiplyNextThrow") {
      action = {
        type: "multiplyNextThrow",
        multiplier: Number(row.querySelector('[data-field="multiplierValue"]').value)
      };
    } else if (actionType === "ignoreNextLanding") {
      action = { type: "ignoreNextLanding", count: 1 };
    } else if (actionType === "randomCell") {
      action = { type: "randomCell" };
    } else {
      action = { type: "display", text: label };
    }

    return {
      id,
      label,
      allocation: {
        mode: allocationMode,
        value: allocationValue
      },
      rerollOnVacate: row.dataset.randomPlaceholder === "true",
      action
    };
  }

  function collectRequest() {
    const instructions = Array.from(
      instructionRows.querySelectorAll(".board-room-instruction-row")
    )
      .filter((row) => row.dataset.enabled !== "false")
      .map(collectInstruction);

    const customPool = [];
    if (randomPoolMode.value === "custom") {
      instructionRows.querySelectorAll(".board-room-instruction-row").forEach((row) => {
        if (row.dataset.enabled === "false") return;
        if (!row.querySelector('[data-field="poolEnabled"]').checked) return;
        customPool.push({
          instructionId: row.querySelector('[data-field="instructionId"]').value.trim(),
          weight: Number(row.querySelector('[data-field="poolWeight"]').value)
        });
      });
    }

    const board = sizingMode.value === "cellCount"
      ? {
          sizingMode: "cellCount",
          columns: null,
          rows: null,
          cellCount: Number(form.elements.namedItem("cellCount").value),
          layoutStyle: form.elements.namedItem("layoutStyle").value
        }
      : {
          sizingMode: "dimensions",
          columns: Number(form.elements.namedItem("columns").value),
          rows: Number(form.elements.namedItem("rows").value),
          cellCount: null,
          layoutStyle: form.elements.namedItem("layoutStyle").value
        };

    return {
      name: form.elements.namedItem("roomName").value.trim() || "Room",
      retentionMinutes: Number(form.elements.namedItem("retentionMinutes").value) || 240,
      pauseDonationMode: form.elements.namedItem("pauseDonationMode").value || "QUEUE",
      pauseGraceSeconds: Number(form.elements.namedItem("pauseGraceSeconds").value) || 0,
      players: collectPlayers(),
      board,
      movement: {
        generator: selectedMovementGenerator(),
        diceCount: Number(form.elements.namedItem("diceCount").value),
        extraThrowOnDouble: form.elements.namedItem("extraThrowOnDouble").checked,
        extraThrowOnYut: form.elements.namedItem("extraThrowOnYutMo").checked,
        extraThrowOnMo: form.elements.namedItem("extraThrowOnYutMo").checked
      },
      rules: {
        landingInstructionMode: "destinationOnly",
        resolveLandingBeforeBonusThrow: true,
        skipNextThrowConsumesBonus: true
      },
      instructions,
      randomPool: {
        mode: randomPoolMode.value,
        entries: randomPoolMode.value === "custom" ? customPool : [],
        allowSameInstruction: null
      }
    };
  }

  function normalizeProfileImageUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const normalized = raw.startsWith("//") ? "https:" + raw : raw;
    try {
      const parsed = new URL(normalized, window.location.href);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed.href
        : "";
    } catch (_) {
      return "";
    }
  }

  function liveText(status) {
    switch (status) {
      case "LIVE": return ["방송 중", "live"];
      case "OFFLINE_OR_UNAVAILABLE": return ["오프라인", "offline"];
      case "CHECK_FAILED": return ["확인 실패", "failed"];
      default: return ["미확인", "unknown"];
    }
  }

  function renderLiveStatuses(snapshot) {
    liveSummary.innerHTML = "";
    const players = snapshot?.config?.players || [];
    players.forEach((player, index) => {
      const [label, tone] = liveText(player.live?.status);
      const card = document.createElement("article");
      card.className = "board-room-live-card " + tone;
      const detail = player.live?.status === "LIVE"
        ? (player.live?.title || "방송 중")
        : (player.live?.error || "현재 방송을 찾지 못했습니다.");
      const profileImageUrl = normalizeProfileImageUrl(player.profileImageUrl);
      const avatarFallback = escapeAttribute(
        String(player.displayName || player.soopId || "?").slice(0, 1)
      );
      const avatarMarkup = profileImageUrl
        ? `<span class="board-room-live-avatar-shell"><img class="board-room-live-avatar" src="${escapeAttribute(profileImageUrl)}" alt="" referrerpolicy="no-referrer" /><span class="board-room-live-avatar-fallback">${avatarFallback}</span></span>`
        : `<span class="board-room-live-avatar-fallback">${avatarFallback}</span>`;
      card.innerHTML = `
        <div class="board-room-live-identity">
          ${avatarMarkup}
          <div>
            <strong>P${index + 1} ${escapeAttribute(player.displayName || player.soopId)}</strong>
            <span>${escapeAttribute(player.soopId)}</span>
          </div>
        </div>
        <div class="board-room-live-state">
          <b>${label}</b>
          <span>${escapeAttribute(detail)}</span>
        </div>
      `;
      const profileImage = card.querySelector(".board-room-live-avatar");
      const profileFallback = card.querySelector(".board-room-live-avatar-shell .board-room-live-avatar-fallback");
      if (profileImage && profileFallback) {
        profileImage.addEventListener("load", () => {
          profileFallback.hidden = true;
        }, { once: true });
        profileImage.addEventListener("error", () => {
          profileImage.hidden = true;
          profileFallback.hidden = false;
        }, { once: true });
      }

      liveSummary.append(card);

      const row = playersRoot.querySelectorAll(".board-room-player-row")[index];
      const inline = row?.querySelector("[data-live-status]");
      if (inline) {
        inline.textContent = label;
        inline.dataset.status = tone;
      }
    });
  }

  function clientBaseUrl() {
    const raw = bridgeOverlayUrl?.value?.trim();
    if (raw) {
      try {
        const parsed = new URL(raw, window.location.href);
        return parsed.origin;
      } catch (_) {
      }
    }
    return window.location.origin;
  }

  function currentWebSocketUrl() {
    const raw = bridgeOverlayUrl?.value?.trim();
    if (raw) {
      try {
        const parsed = new URL(raw, window.location.href);
        const configured = parsed.searchParams.get("ws");
        if (configured) return configured;
      } catch (_) {
      }
    }
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return scheme + "://" + window.location.hostname + ":17831";
  }

  function roomOverlayUrl(snapshot) {
    const style = snapshot?.config?.board?.layoutStyle || "rounded";
    const page = style === "rect"
      ? "/games/board/rect.html"
      : "/games/board/index.html";
    const url = new URL(page, clientBaseUrl());
    url.searchParams.set("roomId", snapshot.roomId);
    return url.toString();
  }

  function previewUrl(snapshot) {
    const style = snapshot?.config?.board?.layoutStyle || "rounded";
    const page = style === "rect" ? "./games/board/rect.html" : "./games/board/index.html";
    const url = new URL(page, window.location.href);
    url.searchParams.set("roomId", snapshot.roomId);
    url.searchParams.set("preview", "1");
    url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  function syncExtensionAvailability() {
    if (!extendButton || !extendControl || !extendMinutes) return;

    const lifecycle = currentRoom?.lifecycle || {};
    const terminated = lifecycle.state === "TERMINATED";
    const expiresAt = lifecycle.expiresAt ? new Date(lifecycle.expiresAt) : null;
    const remainingMs = expiresAt && !Number.isNaN(expiresAt.getTime())
      ? expiresAt.getTime() - Date.now()
      : Number.POSITIVE_INFINITY;

    const withinFinalHour = remainingMs > 0 && remainingMs <= 60 * 60 * 1000;
    extendControl.hidden = terminated;
    extendButton.hidden = terminated;
    extendButton.disabled = terminated || !withinFinalHour;

    const requested = Number(extendMinutes.value);
    if (!Number.isFinite(requested) || requested < 1) extendMinutes.value = "1";
    if (requested > 120) extendMinutes.value = "120";

    if (terminated) {
      extendButton.title = "종료된 룸은 연장할 수 없습니다.";
    } else if (!withinFinalHour) {
      extendButton.title = "룸 종료까지 60분 이하로 남았을 때 연장할 수 있습니다.";
    } else {
      extendButton.title = "1회 최대 120분까지 연장할 수 있습니다.";
    }
  }

  function renderRoom(snapshot) {
    currentRoom = snapshot;
    renderLiveStatuses(snapshot);
    previewPanel.hidden = false;
    previewFrame.src = previewUrl(snapshot);

    const board = snapshot.config?.board;
    previewMeta.textContent =
      snapshot.config?.name + " · " +
      board.columns + "×" + board.rows +
      ", " + board.cellCount + "칸, " +
      (board.layoutStyle === "rect" ? "직각" : "라운드") +
      ", " + snapshot.status;

    const lifecycle = snapshot.lifecycle || {};
    const lifecycleState = lifecycle.state || (snapshot.status === "READY" ? "ACTIVE" : "DRAFT");
    const ready = snapshot.status === "READY";
    const terminated = lifecycleState === "TERMINATED";

    previewMeta.textContent +=
      " · " + lifecycleState +
      ", 유지 " + (lifecycle.retentionMinutes || 240) + "분" +
      (lifecycle.queuedDonations ? ", 대기 후원 " + lifecycle.queuedDonations + "건" : "");

    rerollButton.disabled = ready || terminated;
    commitButton.disabled = ready || terminated;
    commitButton.textContent = ready ? "배치 확정됨" : (terminated ? "종료된 룸" : "이 배치로 확정");

    pauseButton.hidden = lifecycleState !== "ACTIVE";
    resumeButton.hidden = lifecycleState !== "PAUSED";
    terminateButton.hidden = terminated;

    const pauseModeField = form.elements.namedItem("pauseDonationMode");
    if (pauseModeField && lifecycle.pauseDonationMode) {
      pauseModeField.value = lifecycle.pauseDonationMode;
    }
    const pauseGraceField = form.elements.namedItem("pauseGraceSeconds");
    if (pauseGraceField && Number.isFinite(Number(lifecycle.pauseGraceSeconds))) {
      pauseGraceField.value = String(lifecycle.pauseGraceSeconds);
    }

    if (lifecycleState === "PAUSED" && lifecycle.pauseGraceUntil) {
      const graceUntil = new Date(lifecycle.pauseGraceUntil);
      if (!Number.isNaN(graceUntil.getTime())) {
        previewMeta.textContent += ", 후원 유예 종료 " + graceUntil.toLocaleTimeString();
      }
    }

    if (overlayRow && overlayUrl) {
      const overlayAvailable = ready && !terminated;
      overlayRow.hidden = !overlayAvailable;
      overlayUrl.value = overlayAvailable ? roomOverlayUrl(snapshot) : "";
    }

    syncExtensionAvailability();
  }

  async function createRoom(event) {
    event.preventDefault();
    createButton.disabled = true;
    showResult("룸 설정 검증 및 참가자 방송 상태 확인 중…", "working");
    try {
      const snapshot = await fetchJson("/api/board/rooms", {
        method: "POST",
        body: JSON.stringify(collectRequest())
      });
      renderRoom(snapshot);
      showResult("룸을 생성했습니다. 참가자 방송 상태와 보드 프리뷰를 확인하세요.", "success");
    } catch (error) {
      showResult("룸 생성 실패: " + error.message, "error-text");
    } finally {
      createButton.disabled = false;
    }
  }

  async function rerollPreview() {
    if (!currentRoom) return;
    rerollButton.disabled = true;
    showResult("보드 지시문을 다시 배치하는 중…", "working");
    try {
      const snapshot = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(currentRoom.roomId) + "/preview/reroll",
        { method: "POST" }
      );
      renderRoom(snapshot);
      showResult("새 배치를 생성했습니다. START는 일반 칸으로 고정되어 있습니다.", "success");
    } catch (error) {
      showResult("재배치 실패: " + error.message, "error-text");
    } finally {
      if (currentRoom?.status !== "READY") rerollButton.disabled = false;
    }
  }

  async function commitPreview() {
    if (!currentRoom) return;
    rerollButton.disabled = true;
    commitButton.disabled = true;
    showResult("현재 프리뷰를 룸 보드로 확정하는 중…", "working");
    try {
      const snapshot = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(currentRoom.roomId) + "/preview/commit",
        { method: "POST" }
      );
      renderRoom(snapshot);
      showResult("보드 배치를 확정했습니다. 룸 운영 페이지로 이동합니다.", "success");
      const operationUrl = new URL("./board-room.html", window.location.href);
      operationUrl.searchParams.set("roomId", snapshot.roomId);
      window.location.assign(operationUrl.toString());
    } catch (error) {
      showResult("배치 확정 실패: " + error.message, "error-text");
      rerollButton.disabled = false;
      commitButton.disabled = false;
    }
  }

  async function pauseRoom() {
    if (!currentRoom) return;
    pauseButton.disabled = true;
    showResult("룸을 일시정지하는 중…", "working");
    try {
      const snapshot = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(currentRoom.roomId) + "/pause",
        {
          method: "POST",
          body: JSON.stringify({
            donationMode: form.elements.namedItem("pauseDonationMode").value || "QUEUE",
            graceSeconds: Number(form.elements.namedItem("pauseGraceSeconds").value) || 0
          })
        }
      );
      renderRoom(snapshot);
      const graceSeconds = Number(snapshot.lifecycle?.pauseGraceSeconds) || 0;
      showResult(
        snapshot.lifecycle?.pauseDonationMode === "IGNORE"
          ? "일시정지했습니다. 이후 후원은 즉시 무시됩니다."
          : "일시정지했습니다. " + graceSeconds + "초 동안 들어온 후원만 큐에 저장하고 이후 후원은 무시합니다.",
        "success"
      );
    } catch (error) {
      showResult("일시정지 실패: " + error.message, "error-text");
    } finally {
      pauseButton.disabled = false;
    }
  }

  async function resumeRoom() {
    if (!currentRoom) return;
    resumeButton.disabled = true;
    showResult("대기 후원을 순서대로 처리하며 재개하는 중…", "working");
    try {
      const snapshot = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(currentRoom.roomId) + "/resume",
        { method: "POST" }
      );
      renderRoom(snapshot);
      showResult("룸을 재개했습니다. 대기 후원은 수신 순서대로 처리됩니다.", "success");
    } catch (error) {
      showResult("재개 실패: " + error.message, "error-text");
    } finally {
      resumeButton.disabled = false;
    }
  }

  async function extendRoomLifetime() {
    if (!currentRoom || !extendButton || !extendMinutes) return;

    const minutes = Number(extendMinutes.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
      showResult("연장 시간은 1~120분으로 입력하세요.", "error-text");
      return;
    }

    extendButton.disabled = true;
    showResult("룸 종료 시간을 연장하는 중…", "working");
    try {
      const snapshot = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(currentRoom.roomId) + "/extend",
        {
          method: "POST",
          body: JSON.stringify({ minutes })
        }
      );
      renderRoom(snapshot);
      showResult(
        "룸 종료 시간을 " + minutes + "분 연장했습니다. 누적 유지시간에는 8시간 상한을 적용하지 않습니다.",
        "success"
      );
    } catch (error) {
      showResult("시간 연장 실패: " + error.message, "error-text");
      syncExtensionAvailability();
    }
  }

  async function terminateRoom() {
    if (!currentRoom) return;
    terminateButton.disabled = true;
    showResult("룸을 종료하는 중…", "working");
    try {
      const snapshot = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(currentRoom.roomId) + "/terminate",
        { method: "POST" }
      );
      renderRoom(snapshot);
      showResult("룸을 TERMINATED 처리했습니다.", "success");
    } catch (error) {
      showResult("룸 종료 실패: " + error.message, "error-text");
    } finally {
      terminateButton.disabled = false;
    }
  }

  addPlayerButton?.addEventListener("click", () => {
    const p1Value = p1BalloonInput()?.value || "100";
    addPlayerRow({ balloonTrigger: p1Value });
  });

  playersRoot.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-player]");
    if (!button) return;
    const row = button.closest(".board-room-player-row");
    if (row) removePlayerRow(row);
  });

  playersRoot.addEventListener("change", (event) => {
    if (event.target?.id === "boardRoomSharedBalloonEnabled") {
      syncSharedBalloonMode();
    }
  });

  playersRoot.addEventListener("input", (event) => {
    if (event.target?.dataset?.field !== "balloonTrigger") return;
    const firstRow = playerRows()[0];
    if (
      firstRow
      && firstRow.contains(event.target)
      && sharedBalloonCheckbox()?.checked
    ) {
      syncSharedBalloonMode();
    }
  });
  sizingMode.addEventListener("change", syncBoardSizing);
  diceEnabled.addEventListener("change", syncMovement);
  yutEnabled.addEventListener("change", syncMovement);
  form.elements.namedItem("pauseDonationMode")?.addEventListener("change", syncPauseDonationPolicy);
  randomPoolMode.addEventListener("change", syncAllInstructionRows);

  instructionRows.addEventListener("change", (event) => {
    const row = event.target.closest(".board-room-instruction-row");
    if (row) syncInstructionRow(row);
  });
  instructionRows.addEventListener("input", (event) => {
    const row = event.target.closest(".board-room-instruction-row");
    if (!row) return;
    if (
      event.target.dataset.field === "instructionId" ||
      event.target.dataset.field === "label"
    ) {
      updateInstructionListItem(row);
      return;
    }
    syncInstructionRow(row);
  });
  instructionRows.addEventListener("click", (event) => {
    const button = event.target.closest('[data-action="remove"]');
    if (!button) return;
    const row = button.closest(".board-room-instruction-row");
    if (!row) return;
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    selectedInstructionRow = null;
    rebuildInstructionList();
    if (next?.classList?.contains("board-room-instruction-row") && next.isConnected) {
      selectInstruction(next);
    }
  });

  document.querySelectorAll("[data-add-board-instruction]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.addBoardInstruction !== "custom") return;
      addInstruction("custom");
    });
  });

  form.addEventListener("submit", createRoom);
  rerollButton.addEventListener("click", rerollPreview);
  commitButton.addEventListener("click", commitPreview);
  extendButton?.addEventListener("click", extendRoomLifetime);
  extendMinutes?.addEventListener("input", syncExtensionAvailability);
  pauseButton?.addEventListener("click", pauseRoom);
  resumeButton?.addEventListener("click", resumeRoom);
  terminateButton?.addEventListener("click", terminateRoom);

  copyOverlayButton?.addEventListener("click", async () => {
    if (!overlayUrl?.value) return;
    try {
      await navigator.clipboard.writeText(overlayUrl.value);
      showResult("보드게임 OBS 주소를 복사했습니다.", "success");
    } catch (_) {
      overlayUrl.select();
      document.execCommand("copy");
      showResult("보드게임 OBS 주소를 복사했습니다.", "success");
    }
  });

  openOverlayButton?.addEventListener("click", () => {
    if (!overlayUrl?.value) return;
    window.open(overlayUrl.value, "_blank", "noopener,noreferrer");
  });

  renderPlayers();
  syncBoardSizing();
  syncMovement();
  syncPauseDonationPolicy();
  seedDefaultInstructions();
  syncAllInstructionRows();
  rebuildInstructionList();
  syncExtensionAvailability();
  window.setInterval(syncExtensionAvailability, 1000);
})();
