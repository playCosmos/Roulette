(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const connectionBadge = $("connectionBadge");
  const soopStatus = $("soopStatus");
  const streamerId = $("streamerId");
  const pendingTickets = $("pendingTickets");
  const overlayClients = $("overlayClients");
  const donorRows = $("donorRows");
  const operationResult = $("operationResult");
  const refreshButton = $("refreshButton");
  const backupButton = $("backupButton");
  const rebuildButton = $("rebuildButton");
  const testTicketButton = $("testTicketButton");
  const testNickname = $("testNickname");
  const adjustForm = $("adjustForm");
  const configForm = $("configForm");
  const saveConfigButton = $("saveConfigButton");
  const configResult = $("configResult");
  const overlayUrlInput = $("overlayUrlInput");
  const copyOverlayButton = $("copyOverlayButton");
  const copyResult = $("copyResult");

  let refreshTimer = null;
  let refreshing = false;
  let overlayClientCount = 0;

  const STATUS = {
    CONNECTED: ["연결됨", "ok"],
    PROBING: ["방송 확인 중", "working"],
    CONNECTING: ["채팅 연결 중", "working"],
    RECONNECTING: ["재연결 중", "working"],
    WAITING_FOR_STREAMER_ID: ["설정 필요", "waiting"],
    OFFLINE_OR_UNAVAILABLE: ["방송 대기", "waiting"],
    CONNECTION_FAILED: ["연결 실패", "error"],
    DISCONNECTED_ERROR: ["연결 오류", "error"],
    DISCONNECTED: ["연결 끊김", "error"],
    DISABLED: ["비활성", "waiting"],
    STOPPED: ["중지됨", "waiting"],
    IDLE: ["대기 중", "waiting"]
  };

  const RESTART_LABELS = {
    ticket: "티켓 규칙",
    server: "로컬 서버",
    storage: "저장 경로"
  };

  async function fetchJson(url, options) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "Accept": "application/json", ...(options?.headers || {}) },
      ...options
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = { error: text }; }
    }
    if (!response.ok) {
      throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    return payload;
  }

  function showOperation(text, tone = "") {
    operationResult.textContent = text;
    operationResult.className = `operation-result${tone ? ` ${tone}` : ""}`;
  }

  function showConfig(text, tone = "") {
    configResult.textContent = text;
    configResult.className = `operation-result${tone ? ` ${tone}` : ""}`;
  }

  function setConnection(status, error) {
    const [label, tone] = STATUS[status] || [status || "상태 확인 불가", "waiting"];
    connectionBadge.textContent = label;
    connectionBadge.className = `connection ${tone}`;
    soopStatus.textContent = label;
    soopStatus.title = error || "";
  }

  function updateOverlayUrl(state) {
    const ws = state.websocketUrl || `ws://${location.hostname}:17821`;
    overlayUrlInput.value = `${location.origin}/soop-overlay.html?ws=${ws}`;
  }

  function updateTestTicketAvailability() {
    const available = overlayClientCount > 0;
    testTicketButton.disabled = !available;
    testTicketButton.title = available
      ? "연결된 오버레이에 테스트 티켓을 전송합니다."
      : "OBS 또는 방송용 오버레이가 연결되어 있어야 사용할 수 있습니다.";
    if (!available && operationResult.textContent === "대기 중") {
      showOperation("테스트 티켓은 OBS/오버레이 연결 후 사용할 수 있습니다.", "waiting");
    }
  }

  function renderState(state) {
    const soop = state.soop || {};
    setConnection(soop.status, soop.lastError);
    streamerId.textContent = soop.streamerId || state.streamerId || "미설정";
    pendingTickets.textContent = String(state.pendingTickets ?? 0);
    overlayClientCount = Number(state.websocketClients ?? 0);
    overlayClients.textContent = String(overlayClientCount);
    updateTestTicketAvailability();
    updateOverlayUrl(state);
  }

  function formElement(name) {
    return configForm.elements.namedItem(name);
  }

  function fillConfig(config) {
    const ticket = config.ticket || {};
    const server = config.server || {};
    const storage = config.storage || {};
    const soop = config.soop || {};
    formElement("streamerId").value = config.streamerId || "";
    formElement("soopEnabled").checked = soop.enabled !== false;
    formElement("offlinePollSeconds").value = soop.offlinePollSeconds ?? 30;
    formElement("balloonsPerTicket").value = ticket.balloonsPerTicket ?? 50;
    formElement("numberMax").value = ticket.numberMax ?? 28;
    formElement("numberCount").value = ticket.numberCount ?? 7;
    formElement("host").value = server.host || "127.0.0.1";
    formElement("port").value = server.port ?? 17820;
    formElement("websocketPort").value = server.websocketPort ?? 17821;
    formElement("openBrowserOnStart").checked = server.openBrowserOnStart === true;
    formElement("databasePath").value = storage.databasePath || "./data/roulette.db";
    formElement("ticketDirectory").value = storage.ticketDirectory || "./tickets";
    formElement("webRoot").value = storage.webRoot || "./web";
    formElement("backupDirectory").value = storage.backupDirectory || "./backups";
    formElement("logDirectory").value = storage.logDirectory || "./logs";
  }

  function numberValue(name) {
    return Number(formElement(name).value);
  }

  function configFromForm() {
    const numberMax = numberValue("numberMax");
    const numberCount = numberValue("numberCount");
    const port = numberValue("port");
    const websocketPort = numberValue("websocketPort");
    if (!Number.isInteger(numberMax) || numberMax < 1) throw new Error("최대 번호는 1 이상이어야 합니다.");
    if (!Number.isInteger(numberCount) || numberCount < 1 || numberCount > numberMax) {
      throw new Error("선택 번호 개수는 1 이상이며 최대 번호보다 클 수 없습니다.");
    }
    if (port === websocketPort) throw new Error("HTTP Port와 WebSocket Port는 서로 달라야 합니다.");

    return {
      streamerId: formElement("streamerId").value.trim(),
      ticket: {
        balloonsPerTicket: numberValue("balloonsPerTicket"),
        numberMax,
        numberCount
      },
      server: {
        host: formElement("host").value.trim(),
        port,
        websocketPort,
        openBrowserOnStart: formElement("openBrowserOnStart").checked
      },
      storage: {
        databasePath: formElement("databasePath").value.trim(),
        ticketDirectory: formElement("ticketDirectory").value.trim(),
        webRoot: formElement("webRoot").value.trim(),
        backupDirectory: formElement("backupDirectory").value.trim(),
        logDirectory: formElement("logDirectory").value.trim()
      },
      soop: {
        enabled: formElement("soopEnabled").checked,
        offlinePollSeconds: numberValue("offlinePollSeconds")
      }
    };
  }

  async function loadConfig() {
    try {
      const payload = await fetchJson("/api/admin/config");
      fillConfig(payload.config || {});
      if (payload.requiresRestart) {
        const labels = (payload.restartFields || []).map((key) => RESTART_LABELS[key] || key).join(", ");
        showConfig(`저장된 설정 중 ${labels} 변경은 프로그램 재실행 후 적용됩니다.`, "waiting");
      } else {
        showConfig("config.json을 불러왔습니다.");
      }
    } catch (error) {
      showConfig(`설정을 불러오지 못했습니다: ${error.message}`, "error-text");
    }
  }

  function cell(text) {
    const td = document.createElement("td");
    td.textContent = String(text ?? "-");
    return td;
  }

  function renderDonors(donors) {
    donorRows.replaceChildren();
    if (!Array.isArray(donors) || donors.length === 0) {
      const tr = document.createElement("tr");
      const td = cell("등록된 후원자가 없습니다.");
      td.colSpan = 6;
      td.className = "empty-state";
      tr.append(td);
      donorRows.append(tr);
      return;
    }

    for (const donor of donors) {
      const tr = document.createElement("tr");
      tr.append(
        cell(donor.nickname || "익명"),
        cell(donor.donorId),
        cell(donor.totalBalloons ?? 0),
        cell(donor.allocatedTickets ?? 0),
        cell(donor.issuedTickets ?? 0),
        cell(donor.remainderBalloons ?? 0)
      );
      donorRows.append(tr);
    }
  }

  function renderDonorError(error) {
    donorRows.replaceChildren();
    const tr = document.createElement("tr");
    const td = cell(`후원자 목록을 불러오지 못했습니다: ${error.message}`);
    td.colSpan = 6;
    td.className = "empty-state error-text";
    tr.append(td);
    donorRows.append(tr);
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    refreshButton.disabled = true;
    try {
      const [stateResult, donorsResult] = await Promise.allSettled([
        fetchJson("/api/state"),
        fetchJson("/api/admin/donors")
      ]);

      if (stateResult.status === "fulfilled") {
        renderState(stateResult.value);
      } else {
        overlayClientCount = 0;
        updateTestTicketAvailability();
        setConnection("DISCONNECTED_ERROR", stateResult.reason?.message);
        soopStatus.textContent = "브리지 응답 없음";
      }

      if (donorsResult.status === "fulfilled") {
        renderDonors(donorsResult.value.donors || []);
      } else {
        renderDonorError(donorsResult.reason || new Error("알 수 없는 오류"));
      }
    } finally {
      refreshing = false;
      refreshButton.disabled = false;
    }
  }

  async function runAction(button, url, body, successText) {
    button.disabled = true;
    showOperation("처리 중…", "working");
    try {
      const payload = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      showOperation(typeof successText === "function" ? successText(payload) : successText, "success");
      await refresh();
      return payload;
    } catch (error) {
      showOperation(`실패: ${error.message}`, "error-text");
      throw error;
    } finally {
      button.disabled = false;
      if (button === testTicketButton) updateTestTicketAvailability();
    }
  }

  configForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveConfigButton.disabled = true;
    showConfig("config.json 저장 중…", "working");
    try {
      const requested = configFromForm();
      const payload = await fetchJson("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requested)
      });
      fillConfig(payload.config || requested);
      if (payload.requiresRestart) {
        const labels = (payload.restartFields || []).map((key) => RESTART_LABELS[key] || key).join(", ");
        showConfig(`저장 완료. ${labels} 변경은 프로그램 재실행 후 적용됩니다. 스트리머/SOOP 설정은 즉시 적용됩니다.`, "waiting");
      } else if (payload.liveApplied) {
        showConfig("저장 완료. SOOP 연결 설정을 즉시 적용했습니다.", "success");
      } else {
        showConfig("config.json 저장 완료.", "success");
      }
      await refresh();
    } catch (error) {
      showConfig(`저장 실패: ${error.message}`, "error-text");
    } finally {
      saveConfigButton.disabled = false;
    }
  });

  copyOverlayButton.addEventListener("click", async () => {
    const value = overlayUrlInput.value;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        overlayUrlInput.focus();
        overlayUrlInput.select();
        if (!document.execCommand("copy")) throw new Error("clipboard unavailable");
      }
      copyResult.textContent = "오버레이 주소를 복사했습니다. OBS 브라우저 소스 URL에 붙여넣으세요.";
      copyResult.className = "operation-result success";
    } catch {
      copyResult.textContent = "자동 복사에 실패했습니다. 주소 입력란을 선택해 직접 복사하세요.";
      copyResult.className = "operation-result error-text";
    }
  });

  refreshButton.addEventListener("click", () => {
    refresh();
    loadConfig();
  });
  backupButton.addEventListener("click", () => {
    runAction(backupButton, "/api/admin/backup", {}, (p) => `DB 백업 완료: ${p.path}`).catch(() => {});
  });
  rebuildButton.addEventListener("click", () => {
    runAction(rebuildButton, "/api/admin/manifests/rebuild", {}, (p) => `issued.json ${p.rebuilt ?? 0}개 재생성 완료`).catch(() => {});
  });
  testTicketButton.addEventListener("click", () => {
    if (overlayClientCount <= 0) {
      showOperation("실패: OBS 또는 방송용 오버레이가 연결되어 있지 않습니다.", "error-text");
      return;
    }
    runAction(
      testTicketButton,
      "/api/admin/test-ticket",
      { nickname: testNickname.value.trim() || "테스트" },
      "테스트 티켓을 오버레이에 전송했습니다."
    ).catch(() => {});
  });

  adjustForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const submit = adjustForm.querySelector('button[type="submit"]');
    const data = new FormData(adjustForm);
    runAction(submit, "/api/admin/adjust", {
      donorId: String(data.get("donorId") || "").trim(),
      nickname: String(data.get("nickname") || "").trim(),
      balloonDelta: Number(data.get("balloonDelta")),
      reason: String(data.get("reason") || "").trim()
    }, "누적 보정을 적용했습니다.").then(() => adjustForm.reset()).catch(() => {});
  });

  loadConfig();
  refresh();
  refreshTimer = window.setInterval(refresh, 3000);
  window.addEventListener("beforeunload", () => {
    if (refreshTimer) window.clearInterval(refreshTimer);
  });
})();
