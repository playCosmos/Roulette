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
  const adjustLookupResult = $("adjustLookupResult");
  const configForm = $("configForm");
  const saveConfigButton = $("saveConfigButton");
  const configResult = $("configResult");
  const overlayUrlInput = $("overlayUrlInput");
  const copyOverlayButton = $("copyOverlayButton");
  const copyResult = $("copyResult");

  const donorIdInput = adjustForm.elements.namedItem("donorId");
  const nicknameInput = adjustForm.elements.namedItem("nickname");

  let refreshTimer = null;
  let refreshing = false;
  let overlayClientCount = 0;
  let restartInProgress = false;
  let bridgeWasOffline = false;
  let lookupTimer = null;
  let lookupSequence = 0;
  let autoFilledId = false;
  let autoFilledNickname = false;
  let reconnectBannerUntil = new URLSearchParams(location.search).get("restarted") === "1"
    ? Date.now() + 5000
    : 0;

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

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

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
    if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
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

  function showLookup(text, tone = "") {
    adjustLookupResult.textContent = text;
    adjustLookupResult.className = `operation-result${tone ? ` ${tone}` : ""}`;
  }

  function setConnection(status, error) {
    const [label, tone] = STATUS[status] || [status || "상태 확인 불가", "waiting"];
    soopStatus.textContent = label;
    soopStatus.title = error || "";
    if (restartInProgress) {
      connectionBadge.textContent = "재시작 중 · 연결 대기";
      connectionBadge.className = "connection working";
    } else if (Date.now() < reconnectBannerUntil) {
      connectionBadge.textContent = "다시 연결됨";
      connectionBadge.className = "connection ok";
    } else {
      connectionBadge.textContent = label;
      connectionBadge.className = `connection ${tone}`;
    }
  }

  function updateOverlayUrl(state) {
    const ws = state.websocketUrl || `ws://${location.hostname}:17821`;
    overlayUrlInput.value = `${location.origin}/soop-overlay.html?ws=${ws}`;
  }

  function updateTestTicketAvailability() {
    const available = overlayClientCount > 0 && !restartInProgress && !bridgeWasOffline;
    testTicketButton.disabled = !available;
    testTicketButton.title = available
      ? "연결된 오버레이에 테스트 티켓을 전송합니다."
      : "OBS 또는 방송용 오버레이가 연결되어 있어야 사용할 수 있습니다.";
    if (!available && !restartInProgress && !bridgeWasOffline && operationResult.textContent === "대기 중") {
      showOperation("테스트 티켓은 OBS/오버레이 연결 후 사용할 수 있습니다.", "waiting");
    }
  }

  function renderState(state) {
    if (bridgeWasOffline) {
      bridgeWasOffline = false;
      reconnectBannerUntil = Date.now() + 5000;
    }
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
    const threshold = numberValue("balloonsPerTicket");
    const poll = numberValue("offlinePollSeconds");
    if (!Number.isInteger(threshold) || threshold < 1) throw new Error("티켓당 별풍선은 1 이상이어야 합니다.");
    if (!Number.isInteger(numberMax) || numberMax < 1) throw new Error("최대 번호는 1 이상이어야 합니다.");
    if (!Number.isInteger(numberCount) || numberCount < 1 || numberCount > numberMax) {
      throw new Error("선택 번호 개수는 1 이상이며 최대 번호보다 클 수 없습니다.");
    }
    if (!Number.isInteger(poll) || poll < 5) throw new Error("오프라인 재확인 주기는 5초 이상이어야 합니다.");
    if (port === websocketPort) throw new Error("HTTP Port와 WebSocket Port는 서로 달라야 합니다.");

    return {
      streamerId: formElement("streamerId").value.trim(),
      ticket: { balloonsPerTicket: threshold, numberMax, numberCount },
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
      soop: { enabled: formElement("soopEnabled").checked, offlinePollSeconds: poll }
    };
  }

  async function loadConfig() {
    if (restartInProgress) return;
    try {
      const payload = await fetchJson("/api/admin/config");
      fillConfig(payload.config || {});
      if (payload.requiresRestart) {
        const labels = (payload.restartFields || []).map((key) => RESTART_LABELS[key] || key).join(", ");
        showConfig(`${labels} 변경이 감지되었습니다. 설정을 저장하면 자동으로 재시작합니다.`, "waiting");
      } else if (new URLSearchParams(location.search).get("restarted") === "1") {
        showConfig("프로그램 재실행이 완료되어 관리자 페이지가 다시 연결되었습니다.", "success");
      } else {
        showConfig("config.json을 불러왔습니다.");
      }
    } catch (error) {
      if (!restartInProgress) showConfig(`설정을 불러오지 못했습니다: ${error.message}`, "error-text");
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
    const waiting = restartInProgress || bridgeWasOffline;
    const td = cell(waiting ? "브리지 연결을 기다리는 중입니다." : `후원자 목록을 불러오지 못했습니다: ${error.message}`);
    td.colSpan = 6;
    td.className = waiting ? "empty-state" : "empty-state error-text";
    tr.append(td);
    donorRows.append(tr);
  }

  async function refresh() {
    if (refreshing || restartInProgress) return;
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
        bridgeWasOffline = true;
        overlayClientCount = 0;
        updateTestTicketAvailability();
        connectionBadge.textContent = "브리지 연결 대기";
        connectionBadge.className = "connection working";
        soopStatus.textContent = "프로그램 연결 대기";
        soopStatus.title = stateResult.reason?.message || "";
      }
      if (donorsResult.status === "fulfilled") renderDonors(donorsResult.value.donors || []);
      else renderDonorError(donorsResult.reason || new Error("알 수 없는 오류"));
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

  async function waitForRestart(nextAdminUrl) {
    restartInProgress = true;
    if (refreshTimer) window.clearInterval(refreshTimer);
    overlayClientCount = 0;
    updateTestTicketAvailability();
    connectionBadge.textContent = "재시작 중 · 연결 대기";
    connectionBadge.className = "connection working";
    soopStatus.textContent = "브리지 재시작 중";
    donorRows.innerHTML = '<tr><td colspan="6" class="empty-state">브리지 재시작을 기다리는 중입니다.</td></tr>';

    let target;
    try { target = new URL(nextAdminUrl || location.href, location.href); }
    catch { target = new URL(location.href); }
    const healthUrl = `${target.origin}/health`;
    await sleep(1700);

    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(`${healthUrl}?t=${Date.now()}`, { cache: "no-store", mode: "cors" });
        if (response.ok) {
          const destination = new URL(target.toString());
          destination.searchParams.set("restarted", "1");
          window.location.replace(destination.toString());
          return;
        }
      } catch {
        // Expected while the old process is down and the new one is starting.
      }
      await sleep(700);
    }

    restartInProgress = false;
    bridgeWasOffline = true;
    connectionBadge.textContent = "재연결 실패";
    connectionBadge.className = "connection error";
    showConfig("자동 재시작 후 브리지에 다시 연결하지 못했습니다. 트레이 상태를 확인하세요.", "error-text");
    refreshTimer = window.setInterval(refresh, 3000);
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
      if (payload.restartScheduled) {
        const labels = (payload.restartFields || []).map((key) => RESTART_LABELS[key] || key).join(", ");
        showConfig(`저장 완료. ${labels} 변경을 적용하기 위해 자동 재시작합니다.`, "working");
        saveConfigButton.disabled = true;
        waitForRestart(payload.nextAdminUrl);
        return;
      }
      if (payload.requiresRestart) {
        const labels = (payload.restartFields || []).map((key) => RESTART_LABELS[key] || key).join(", ");
        showConfig(`저장 완료. ${labels} 변경은 재실행이 필요하지만 현재 환경에서는 자동 재시작을 사용할 수 없습니다.`, "waiting");
      } else if (payload.liveApplied) {
        showConfig("저장 완료. SOOP 연결 설정을 즉시 적용했습니다.", "success");
      } else {
        showConfig("config.json 저장 완료.", "success");
      }
      await refresh();
    } catch (error) {
      showConfig(`저장 실패: ${error.message}`, "error-text");
    } finally {
      if (!restartInProgress) saveConfigButton.disabled = false;
    }
  });

  copyOverlayButton.addEventListener("click", async () => {
    const value = overlayUrlInput.value;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
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

  function fillResolvedIdentity(match, field, source) {
    if (!match) return false;
    if (field === "id") {
      nicknameInput.value = match.nickname || "";
      autoFilledNickname = true;
    } else {
      donorIdInput.value = match.donorId || "";
      autoFilledId = true;
    }
    const origin = source === "local" ? "기존 후원자 DB" : "SOOP 직접 조회";
    showLookup(`${origin}에서 ${match.nickname} (${match.donorId}) 사용자를 확인했습니다.`, "success");
    return true;
  }

  async function resolveAdjustmentIdentity(field, force = false) {
    const seq = ++lookupSequence;
    const input = field === "id" ? donorIdInput : nicknameInput;
    const counterpart = field === "id" ? nicknameInput : donorIdInput;
    const value = input.value.trim();
    if (!value) return false;
    if (counterpart.value.trim() && !force) return true;

    showLookup("기존 후원자 기록 확인 중…", "working");
    try {
      const local = await fetchJson(`/api/admin/donor-resolve?field=${encodeURIComponent(field)}&value=${encodeURIComponent(value)}`);
      if (seq !== lookupSequence) return false;
      if (local.resolved) return fillResolvedIdentity(local.match, field, "local");
      if (Array.isArray(local.candidates) && local.candidates.length > 1) {
        const summary = local.candidates.slice(0, 4).map((item) => `${item.nickname} (${item.donorId})`).join(", ");
        showLookup(`같은 값의 기존 기록이 여러 개입니다: ${summary}. ID를 확인해 주세요.`, "waiting");
        return false;
      }

      showLookup("신규 값입니다. SOOP에서 직접 조회 중…", "working");
      const direct = await fetchJson(`/api/admin/donor-lookup?field=${encodeURIComponent(field)}&value=${encodeURIComponent(value)}`);
      if (seq !== lookupSequence) return false;
      if (direct.resolved) return fillResolvedIdentity(direct.match, field, "direct");

      const candidates = Array.isArray(direct.candidates) ? direct.candidates : [];
      if (candidates.length) {
        const summary = candidates.slice(0, 5).map((item) => `${item.nickname} (${item.donorId})`).join(", ");
        showLookup(`정확 일치가 없어 자동 확정하지 않았습니다. 후보: ${summary}`, "waiting");
      } else {
        showLookup("SOOP 직접 조회에서도 사용자를 확인하지 못했습니다. ID와 닉네임을 모두 직접 입력해 주세요.", "waiting");
      }
      return false;
    } catch (error) {
      if (seq === lookupSequence) showLookup(`사용자 조회 실패: ${error.message}`, "error-text");
      return false;
    }
  }

  function scheduleIdentityLookup(field) {
    if (lookupTimer) window.clearTimeout(lookupTimer);
    lookupTimer = window.setTimeout(() => resolveAdjustmentIdentity(field), 650);
  }

  donorIdInput.addEventListener("input", () => {
    if (autoFilledNickname) {
      nicknameInput.value = "";
      autoFilledNickname = false;
    }
    autoFilledId = false;
    if (donorIdInput.value.trim() && !nicknameInput.value.trim()) scheduleIdentityLookup("id");
  });

  nicknameInput.addEventListener("input", () => {
    if (autoFilledId) {
      donorIdInput.value = "";
      autoFilledId = false;
    }
    autoFilledNickname = false;
    if (nicknameInput.value.trim() && !donorIdInput.value.trim()) scheduleIdentityLookup("nickname");
  });

  donorIdInput.addEventListener("blur", () => {
    if (donorIdInput.value.trim() && !nicknameInput.value.trim()) resolveAdjustmentIdentity("id");
  });
  nicknameInput.addEventListener("blur", () => {
    if (nicknameInput.value.trim() && !donorIdInput.value.trim()) resolveAdjustmentIdentity("nickname");
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

  adjustForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = adjustForm.querySelector('button[type="submit"]');
    let donorId = donorIdInput.value.trim();
    let nickname = nicknameInput.value.trim();
    if (!donorId && !nickname) {
      showLookup("SOOP 사용자 ID 또는 닉네임 중 하나를 입력하세요.", "error-text");
      return;
    }
    if (!donorId) {
      await resolveAdjustmentIdentity("nickname", true);
      donorId = donorIdInput.value.trim();
      nickname = nicknameInput.value.trim();
    } else if (!nickname) {
      await resolveAdjustmentIdentity("id", true);
      donorId = donorIdInput.value.trim();
      nickname = nicknameInput.value.trim();
    }
    if (!donorId || !nickname) {
      showLookup("사용자를 확정하지 못했습니다. 조회 결과를 확인하거나 ID와 닉네임을 모두 입력하세요.", "error-text");
      return;
    }

    const data = new FormData(adjustForm);
    runAction(submit, "/api/admin/adjust", {
      donorId,
      nickname,
      balloonDelta: Number(data.get("balloonDelta")),
      reason: String(data.get("reason") || "").trim()
    }, "누적 보정을 적용했습니다.").then(() => {
      adjustForm.reset();
      autoFilledId = false;
      autoFilledNickname = false;
      showLookup("ID 또는 닉네임을 입력하면 자동으로 사용자를 확인합니다.");
    }).catch(() => {});
  });

  loadConfig();
  refresh();
  refreshTimer = window.setInterval(refresh, 3000);
  window.addEventListener("beforeunload", () => {
    if (refreshTimer) window.clearInterval(refreshTimer);
    if (lookupTimer) window.clearTimeout(lookupTimer);
  });
})();
