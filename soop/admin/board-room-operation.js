(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const roomId = String(params.get("roomId") || "").trim();

  const title = $("roomOperationTitle");
  const meta = $("roomOperationMeta");
  const statusBadge = $("roomOperationStatus");
  const result = $("roomOperationResult");
  const pauseButton = $("roomPauseButton");
  const resumeButton = $("roomResumeButton");
  const extendMinutes = $("roomExtendMinutes");
  const extendButton = $("roomExtendButton");
  const terminateButton = $("roomTerminateButton");
  const playerList = $("roomPlayerOperationList");
  const boardFrame = $("roomOperationBoard");
  const settingsContent = $("roomFixedSettingsContent");

  let room = null;
  let runtime = null;
  let serverState = null;
  let socket = null;
  let refreshTimer = 0;
  let boardLoadedForRoom = "";

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
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
      throw new Error(payload.error || response.status + " " + response.statusText);
    }
    return payload;
  }

  function showResult(message, tone = "") {
    result.textContent = message;
    result.className = "operation-result" + (tone ? " " + tone : "");
  }

  function lifecycleState() {
    return String(room?.lifecycle?.state || "UNKNOWN");
  }

  function roomOperable() {
    return room?.status === "READY" && lifecycleState() !== "TERMINATED";
  }

  function movementLabel(movement) {
    const generator = movement?.generator;
    if (generator === "mixed") return "주사위 + 윷 혼합";
    if (generator === "yut") return "윷";
    return "주사위";
  }

  function allocationLabel(allocation) {
    if (!allocation) return "-";
    const value = Number(allocation.value);
    return allocation.mode === "ratio"
      ? (Number.isFinite(value) ? value : 0) + "%"
      : (Number.isFinite(value) ? value : 0) + "개";
  }

  function actionSummary(instruction) {
    const action = instruction?.action;
    if (!action || typeof action !== "object") return "표시";
    if (action.type === "move") {
      const steps = action.steps?.mode === "range"
        ? action.steps.min + "~" + action.steps.max
        : action.steps?.value;
      return "이동 " + steps + "칸 " + (action.direction === "backward" ? "뒤로" : "앞으로");
    }
    if (action.type === "skipThrow") return "다음 던지기 무효";
    if (action.type === "multiplyNextThrow") return "다음 던지기 " + action.multiplier + "배";
    if (action.type === "ignoreNextLanding") return "다음 칸 무효화";
    if (action.type === "moveToStart") return "START 이동";
    if (action.type === "extraThrow") return "한 번 더";
    return action.type || "표시";
  }

  function renderHeader() {
    title.textContent = room?.config?.name || "룸 운영";
    const state = lifecycleState();
    const expires = room?.lifecycle?.expiresAt
      ? new Date(room.lifecycle.expiresAt).toLocaleString()
      : "-";
    meta.textContent = "상태 " + state + " · 종료 예정 " + expires;

    statusBadge.textContent = state;
    statusBadge.dataset.state = state;

    const active = state === "ACTIVE";
    const paused = state === "PAUSED";
    const terminated = state === "TERMINATED";

    pauseButton.hidden = !active;
    resumeButton.hidden = !paused;
    pauseButton.disabled = !active;
    resumeButton.disabled = !paused;
    terminateButton.disabled = terminated;

    const expiry = Date.parse(room?.lifecycle?.expiresAt || "");
    const extensionWindow = Number.isFinite(expiry)
      ? (expiry - Date.now()) <= 60 * 60 * 1000 && expiry > Date.now()
      : false;
    extendMinutes.disabled = terminated;
    extendButton.disabled = terminated || !extensionWindow;
    extendButton.title = extensionWindow
      ? "룸 종료 시간을 연장합니다."
      : "종료 예정 60분 전부터 연장할 수 있습니다.";
  }

  function renderPlayers() {
    const runtimeById = new Map(
      (runtime?.players || []).map((player) => [String(player.soopId), player])
    );
    const cellCount = Number(runtime?.board?.cellCount || room?.config?.board?.cellCount || 0);
    const operable = roomOperable();

    playerList.innerHTML = "";
    (room?.config?.players || []).forEach((player, index) => {
      const current = runtimeById.get(String(player.soopId)) || {};
      const position = Number(current.position) || 0;
      const laps = Number(current.laps) || 0;

      const card = document.createElement("article");
      card.className = "room-player-operation-card";
      card.innerHTML = `
        <div class="room-player-operation-head">
          <div>
            <span class="room-player-number">P${index + 1}</span>
            <strong>${escapeHtml(player.displayName || ("플레이어 " + (index + 1)))}</strong>
          </div>
          <div class="room-player-position">
            <span>현재 칸</span>
            <strong>${position}</strong>
            <small>${laps} lap</small>
          </div>
        </div>
        <div class="room-player-operation-actions">
          <button type="button" data-manual-turn>이동값 생성</button>
          <div class="room-player-position-control">
            <input
              data-position
              type="number"
              min="0"
              max="${Math.max(0, cellCount - 1)}"
              step="1"
              value="${position}"
              aria-label="이동할 칸 번호"
            />
            <button type="button" data-set-position>해당 칸으로 이동</button>
          </div>
        </div>
      `;

      const turn = card.querySelector("[data-manual-turn]");
      const setPosition = card.querySelector("[data-set-position]");
      const positionInput = card.querySelector("[data-position]");

      turn.disabled = !operable;
      setPosition.disabled = !operable;
      positionInput.disabled = !operable;

      turn.addEventListener("click", () => manualTurn(player, turn));
      setPosition.addEventListener("click", () => {
        setPositionForPlayer(player, positionInput, setPosition);
      });

      playerList.append(card);
    });
  }

  function renderFixedSettings() {
    const config = room?.config || {};
    const board = config.board || {};
    const movement = config.movement || {};
    const rules = config.rules || {};

    const playerRows = (config.players || []).map((player, index) => `
      <tr>
        <td>P${index + 1}</td>
        <td>${escapeHtml(player.displayName)}</td>
        <td><code>${escapeHtml(player.soopId)}</code></td>
        <td>${Number(player.balloonTrigger) || 0}</td>
      </tr>
    `).join("");

    const instructionRows = (config.instructions || []).map((instruction) => `
      <tr>
        <td>${escapeHtml(instruction.label || instruction.id)}</td>
        <td><code>${escapeHtml(instruction.id)}</code></td>
        <td>${escapeHtml(allocationLabel(instruction.allocation))}</td>
        <td>${escapeHtml(actionSummary(instruction))}</td>
      </tr>
    `).join("");

    settingsContent.innerHTML = `
      <div class="room-fixed-grid">
        <div><span>보드</span><strong>${board.columns}×${board.rows} / ${board.cellCount}칸</strong></div>
        <div><span>형상</span><strong>${escapeHtml(board.layoutStyle)}</strong></div>
        <div><span>이동 생성</span><strong>${escapeHtml(movementLabel(movement))}</strong></div>
        <div><span>주사위</span><strong>${movement.diceCount || 0}개</strong></div>
        <div><span>더블 추가 던지기</span><strong>${movement.extraThrowOnDouble ? "사용" : "미사용"}</strong></div>
        <div><span>윷/모 추가 던지기</span><strong>${movement.extraThrowOnYut || movement.extraThrowOnMo ? "사용" : "미사용"}</strong></div>
        <div><span>착지 처리</span><strong>${escapeHtml(rules.landingInstructionMode || "-")}</strong></div>
        <div><span>룸 유지시간</span><strong>${room?.lifecycle?.retentionMinutes || 0}분</strong></div>
      </div>

      <h3>플레이어 / 별풍선 트리거</h3>
      <div class="room-fixed-table-wrap">
        <table class="room-fixed-table">
          <thead><tr><th></th><th>표시 이름</th><th>SOOP ID</th><th>별풍선</th></tr></thead>
          <tbody>${playerRows}</tbody>
        </table>
      </div>

      <h3>지시문</h3>
      <div class="room-fixed-table-wrap">
        <table class="room-fixed-table">
          <thead><tr><th>표시</th><th>ID</th><th>배치</th><th>동작</th></tr></thead>
          <tbody>${instructionRows || '<tr><td colspan="4">활성 지시문 없음</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  function ensureBoardFrame() {
    if (!roomId || !serverState?.websocketUrl || boardLoadedForRoom === roomId) return;
    const url = new URL("./games/board/index.html", window.location.href);
    url.searchParams.set("roomId", roomId);
    url.searchParams.set("board", "committed");
    url.searchParams.set("ws", serverState.websocketUrl);
    boardFrame.src = url.toString();
    boardLoadedForRoom = roomId;
  }

  function render() {
    renderHeader();
    renderPlayers();
    renderFixedSettings();
    ensureBoardFrame();
  }

  async function refresh() {
    if (!roomId) {
      statusBadge.textContent = "roomId 없음";
      showResult("운영할 roomId가 없습니다.", "error-text");
      return;
    }

    try {
      const nextRoom = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(roomId)
      );

      let nextRuntime = runtime;
      if (String(nextRoom?.lifecycle?.state || "") !== "TERMINATED") {
        try {
          nextRuntime = await fetchJson(
            "/api/board/rooms/" + encodeURIComponent(roomId) + "/runtime"
          );
        } catch (_) {
          // Keep the last valid runtime snapshot while the room record remains readable.
        }
      }

      room = nextRoom;
      runtime = nextRuntime;
      render();
    } catch (error) {
      statusBadge.textContent = "오류";
      showResult("룸 상태 조회 실패: " + error.message, "error-text");
    }
  }

  function scheduleRefresh(delay = 80) {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      refresh();
    }, delay);
  }

  async function manualTurn(player, button) {
    button.disabled = true;
    showResult((player.displayName || player.soopId) + " 이동값 생성 중…", "working");
    try {
      const event = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(roomId) + "/manual-turn",
        {
          method: "POST",
          body: JSON.stringify({ soopId: player.soopId })
        }
      );
      const throws = Array.isArray(event.throwResolutions)
        ? event.throwResolutions.length
        : 0;
      showResult(
        (player.displayName || player.soopId) + " 턴 처리 완료 · "
          + event.startPosition + " → " + event.endPosition
          + " · 던지기 " + throws + "회",
        "success"
      );
      await refresh();
    } catch (error) {
      showResult("수동 턴 실패: " + error.message, "error-text");
    } finally {
      button.disabled = !roomOperable();
    }
  }

  async function setPositionForPlayer(player, input, button) {
    const cellIndex = Number(input.value);
    const cellCount = Number(runtime?.board?.cellCount || 0);
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= cellCount) {
      showResult("칸 번호는 0~" + Math.max(0, cellCount - 1) + " 범위여야 합니다.", "error-text");
      return;
    }

    button.disabled = true;
    showResult((player.displayName || player.soopId) + " 위치 보정 중…", "working");
    try {
      const event = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(roomId) + "/position",
        {
          method: "POST",
          body: JSON.stringify({
            soopId: player.soopId,
            cellIndex
          })
        }
      );
      showResult(
        (player.displayName || player.soopId)
          + " 위치를 " + event.startPosition + " → " + event.endPosition + " 칸으로 변경했습니다.",
        "success"
      );
      await refresh();
    } catch (error) {
      showResult("위치 이동 실패: " + error.message, "error-text");
    } finally {
      button.disabled = !roomOperable();
    }
  }

  async function pauseRoom() {
    pauseButton.disabled = true;
    try {
      room = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(roomId) + "/pause",
        {
          method: "POST",
          body: JSON.stringify({
            donationMode: room?.lifecycle?.pauseDonationMode || "QUEUE",
            graceSeconds: Number(room?.lifecycle?.pauseGraceSeconds) || 0
          })
        }
      );
      showResult("룸을 일시정지했습니다. 수동 운영은 계속 가능합니다.", "success");
      await refresh();
    } catch (error) {
      showResult("일시정지 실패: " + error.message, "error-text");
    } finally {
      pauseButton.disabled = false;
    }
  }

  async function resumeRoom() {
    resumeButton.disabled = true;
    try {
      await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(roomId) + "/resume",
        { method: "POST" }
      );
      showResult("룸을 재개했습니다.", "success");
      await refresh();
    } catch (error) {
      showResult("재개 실패: " + error.message, "error-text");
    } finally {
      resumeButton.disabled = false;
    }
  }

  async function extendRoom() {
    const minutes = Number(extendMinutes.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
      showResult("연장 시간은 1~120분으로 입력하세요.", "error-text");
      return;
    }

    extendButton.disabled = true;
    try {
      room = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(roomId) + "/extend",
        {
          method: "POST",
          body: JSON.stringify({ minutes })
        }
      );
      showResult("룸 시간을 " + minutes + "분 연장했습니다.", "success");
      await refresh();
    } catch (error) {
      showResult("시간 연장 실패: " + error.message, "error-text");
    } finally {
      renderHeader();
    }
  }

  async function terminateRoom() {
    if (!window.confirm("이 룸을 종료할까요? 종료 후에는 턴을 진행할 수 없습니다.")) return;
    terminateButton.disabled = true;
    try {
      room = await fetchJson(
        "/api/board/rooms/" + encodeURIComponent(roomId) + "/terminate",
        { method: "POST" }
      );
      showResult("룸을 종료했습니다.", "success");
      await refresh();
    } catch (error) {
      showResult("룸 종료 실패: " + error.message, "error-text");
    } finally {
      renderHeader();
    }
  }

  async function loadServerState() {
    try {
      serverState = await fetchJson("/api/state");
      ensureBoardFrame();
      connectSocket();
    } catch (error) {
      showResult("서버 상태 조회 실패: " + error.message, "error-text");
    }
  }

  function connectSocket() {
    if (!serverState?.websocketUrl || socket) return;

    try {
      socket = new WebSocket(serverState.websocketUrl);
    } catch (_) {
      socket = null;
      return;
    }

    socket.addEventListener("message", (message) => {
      let payload;
      try { payload = JSON.parse(message.data); }
      catch { return; }
      if (payload?.type !== "board.turn") return;
      if (String(payload.roomId) !== roomId) return;
      scheduleRefresh();
    });

    socket.addEventListener("close", () => {
      socket = null;
      window.setTimeout(connectSocket, 1000);
    });
    socket.addEventListener("error", () => {});
  }

  pauseButton.addEventListener("click", pauseRoom);
  resumeButton.addEventListener("click", resumeRoom);
  extendButton.addEventListener("click", extendRoom);
  terminateButton.addEventListener("click", terminateRoom);

  window.addEventListener("beforeunload", () => {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    if (refreshTimer) window.clearTimeout(refreshTimer);
  });

  loadServerState();
  refresh();
  window.setInterval(refresh, 2000);
})();
