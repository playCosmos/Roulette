(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    connectionBadge: $("connectionBadge"),
    soopStatus: $("soopStatus"),
    streamerId: $("streamerId"),
    capturedCount: $("capturedCount"),
    bufferedCount: $("bufferedCount"),
    droppedCount: $("droppedCount"),
    eventFilter: $("eventFilter"),
    searchInput: $("searchInput"),
    autoScroll: $("autoScroll"),
    pauseButton: $("pauseButton"),
    clearButton: $("clearButton"),
    eventCounts: $("eventCounts"),
    streamNotice: $("streamNotice"),
    eventStream: $("eventStream"),
    emptyState: $("emptyState"),
    liveIndicator: $("liveIndicator")
  };

  const STATUS_LABELS = {
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
    STOPPED: ["중지됨", "error"],
    IDLE: ["대기 중", "waiting"]
  };

  const MAX_RENDERED = 3000;
  let lastSequence = 0;
  let latestServerSequence = 0;
  let paused = false;
  let stateInstanceId = null;
  let stateWasReachable = false;
  let pollingEvents = false;
  let rendered = [];
  let knownTypes = new Set();

  function api(path, options) {
    return fetch(path, {
      cache: "no-store",
      ...options
    }).then(async (response) => {
      let payload = null;
      try {
        payload = await response.json();
      } catch (_) {
        payload = null;
      }
      if (!response.ok) {
        const message = payload?.error || `${response.status} ${response.statusText}`;
        throw new Error(message);
      }
      return payload;
    });
  }

  function setConnectionStatus(status) {
    const [label, tone] = STATUS_LABELS[status] || [status || "대기 중", "waiting"];
    els.soopStatus.textContent = label;
    els.connectionBadge.textContent = label;
    els.connectionBadge.className = `connection ${tone}`;
    els.liveIndicator.classList.toggle("offline", tone === "error");
  }

  async function refreshState() {
    try {
      const state = await api("/api/state");
      const nextInstanceId = state?.instanceId || null;
      if (stateInstanceId && nextInstanceId && stateInstanceId !== nextInstanceId) {
        resetForNewBridgeInstance();
      }
      stateInstanceId = nextInstanceId;
      stateWasReachable = true;
      els.streamerId.textContent = state?.soop?.streamerId || state?.streamerId || "-";
      setConnectionStatus(state?.soop?.status || "IDLE");
    } catch (error) {
      stateWasReachable = false;
      els.connectionBadge.textContent = "브리지 연결 대기";
      els.connectionBadge.className = "connection error";
      els.soopStatus.textContent = "연결 대기";
      els.liveIndicator.classList.add("offline");
      setNotice(`브리지 응답 대기 중: ${error.message}`, "error");
    }
  }

  function resetForNewBridgeInstance() {
    lastSequence = 0;
    latestServerSequence = 0;
    rendered.forEach((item) => item.node.remove());
    rendered = [];
    knownTypes = new Set();
    rebuildTypeFilter();
    els.eventCounts.replaceChildren();
    els.capturedCount.textContent = "0";
    els.bufferedCount.textContent = "0 / 5000";
    els.droppedCount.textContent = "0";
    ensureEmptyState();
    setNotice("브리지가 다시 시작되어 새 이벤트 버퍼를 연결합니다.", "warning");
  }

  async function pollEvents() {
    if (paused || pollingEvents) return;
    pollingEvents = true;
    try {
      const result = await api(`/api/channel/events?after=${encodeURIComponent(lastSequence)}&limit=500`);
      latestServerSequence = Number(result?.latestSequence || latestServerSequence || 0);
      els.capturedCount.textContent = Number(result?.totalCaptured || 0).toLocaleString();
      els.bufferedCount.textContent = `${Number(result?.buffered || 0).toLocaleString()} / ${Number(result?.capacity || 5000).toLocaleString()}`;
      els.droppedCount.textContent = Number(result?.dropped || 0).toLocaleString();
      renderCounts(result?.counts || {});

      if (result?.truncated) {
        setNotice("화면이 오래 멈춰 있는 동안 서버 이벤트 버퍼가 순환되어 일부 과거 이벤트가 누락되었습니다.", "warning");
      } else if (stateWasReachable) {
        setNotice("실시간 이벤트 수집 중입니다.", "");
      }

      const events = Array.isArray(result?.events) ? result.events : [];
      for (const event of events) {
        appendEvent(event);
        lastSequence = Math.max(lastSequence, Number(event.sequence || 0));
      }
      if (events.length && els.autoScroll.checked) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
      }
    } catch (error) {
      if (stateWasReachable) {
        setNotice(`이벤트 API 대기 중: ${error.message}`, "error");
      }
    } finally {
      pollingEvents = false;
    }
  }

  function appendEvent(event) {
    if (!event || !event.type) return;
    knownTypes.add(event.type);
    rebuildTypeFilter();

    const card = document.createElement("article");
    card.className = "event-card";
    card.dataset.type = event.type;
    card.dataset.group = groupFor(event);

    const summaryButton = document.createElement("button");
    summaryButton.type = "button";
    summaryButton.className = "event-summary";
    summaryButton.setAttribute("aria-expanded", "false");

    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = formatTime(event.receivedAt);

    const type = document.createElement("span");
    type.className = "event-type";
    type.textContent = event.type;

    const code = document.createElement("span");
    code.className = "event-code";
    code.textContent = `#${event.code}`;

    const text = document.createElement("span");
    text.className = "event-text";
    text.textContent = summarize(event);

    summaryButton.append(time, type, code, text);

    const details = document.createElement("div");
    details.className = "event-details";
    details.append(
      buildMeta(event),
      buildDetailGrid(event)
    );

    summaryButton.addEventListener("click", () => {
      const expanded = card.classList.toggle("expanded");
      summaryButton.setAttribute("aria-expanded", String(expanded));
    });

    card.append(summaryButton, details);
    els.eventStream.append(card);
    els.emptyState?.remove();

    const searchText = [
      event.type,
      event.description,
      event.eventClass,
      event.streamerId,
      event.raw,
      JSON.stringify(event.payload || {})
    ].join(" ").toLowerCase();
    rendered.push({ node: card, event, searchText });
    if (rendered.length > MAX_RENDERED) {
      const removed = rendered.shift();
      removed?.node.remove();
    }
    applyFilters();
  }

  function buildMeta(event) {
    const grid = document.createElement("div");
    grid.className = "meta-grid";
    const values = [
      ["Sequence", event.sequence],
      ["Event class", event.eventClass || "-"],
      ["Streamer", event.streamerId || "-"],
      ["Source timestamp", formatSourceTimestamp(event.sourceTimestamp)]
    ];
    for (const [label, value] of values) {
      const item = document.createElement("div");
      const key = document.createElement("span");
      key.textContent = label;
      const data = document.createElement("strong");
      data.textContent = String(value ?? "-");
      item.append(key, data);
      grid.append(item);
    }
    return grid;
  }

  function buildDetailGrid(event) {
    const grid = document.createElement("div");
    grid.className = "detail-grid";

    const payloadBlock = document.createElement("div");
    payloadBlock.className = "detail-block";
    const payloadTitle = document.createElement("h3");
    payloadTitle.textContent = "Parsed payload";
    const payload = document.createElement("pre");
    payload.textContent = JSON.stringify(event.payload || {}, null, 2);
    payloadBlock.append(payloadTitle, payload);

    const rawBlock = document.createElement("div");
    rawBlock.className = "detail-block";
    const rawTitle = document.createElement("h3");
    rawTitle.textContent = "Raw packet";
    const raw = document.createElement("pre");
    raw.textContent = event.raw || "(raw payload 없음)";
    rawBlock.append(rawTitle, raw);

    grid.append(payloadBlock, rawBlock);
    return grid;
  }

  function summarize(event) {
    const p = event.payload || {};
    const nickname = firstValue(p.senderNickname, p.userNickname, p.nickname, p.userNick, p.nick);
    const userId = firstValue(p.senderId, p.userId, p.userID, p.id);
    const message = firstValue(p.message, p.msg, p.notice, p.content, p.text);

    if (event.type === "CHAT_MESSAGE") {
      const who = nickname || userId || "unknown";
      return `${who}: ${message || "(메시지 없음)"}`;
    }
    if (event.type === "SEND_BALLOON") {
      const who = nickname || userId || "unknown";
      return `${who} · 별풍선 ${p.count ?? "?"}개 · fanOrder ${p.fanOrder ?? "-"}`;
    }
    if (event.type === "JOIN_CHANNEL") return "채널 JOIN 완료";
    if (event.type === "DISCONNECTED") return `연결 종료 · ${p.reason || "reason 없음"}`;
    if (event.type === "RECONNECTING") return `재연결 시도 ${p.attemptNumber ?? "?"}/${p.maxAttempts ?? "?"}`;
    if (event.type === "RECONNECTED") return "채널 재연결 완료";

    const parts = [];
    if (nickname) parts.push(nickname);
    else if (userId) parts.push(userId);
    if (message) parts.push(message);
    if (p.count != null) parts.push(`count=${p.count}`);
    if (p.amount != null) parts.push(`amount=${p.amount}`);
    return parts.join(" · ") || event.description || event.eventClass || "이벤트";
  }

  function firstValue(...values) {
    return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
  }

  function groupFor(event) {
    const code = Number(event.code);
    if (event.type === "RAW" || event.type === "NONE_TYPE") return "raw";
    if (code < 0 || code <= 2) return "connection";
    if (code >= 18 && code <= 22) return "donation";
    if ([33, 34, 37, 38, 41, 44, 45, 70, 71, 86, 87, 91, 92, 93, 102, 103, 105, 108, 118, 120, 121, 125].includes(code)) return "donation";
    if (code >= 3 && code <= 9) return "chat";
    if ((code >= 10 && code <= 17) || (code >= 23 && code <= 27) || (code >= 51 && code <= 58) || (code >= 76 && code <= 79)) return "moderation";
    return "system";
  }

  function renderCounts(counts) {
    els.eventCounts.replaceChildren();
    const entries = Object.entries(counts)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [type, count] of entries) {
      knownTypes.add(type);
      const chip = document.createElement("span");
      chip.className = "count-chip";
      const label = document.createTextNode(`${type} `);
      const number = document.createElement("strong");
      number.textContent = Number(count || 0).toLocaleString();
      chip.append(label, number);
      els.eventCounts.append(chip);
    }
    rebuildTypeFilter();
  }

  function rebuildTypeFilter() {
    const selected = els.eventFilter.value;
    const existing = new Set(Array.from(els.eventFilter.options).map((option) => option.value));
    for (const type of Array.from(knownTypes).sort()) {
      if (existing.has(type)) continue;
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      els.eventFilter.append(option);
    }
    if (Array.from(els.eventFilter.options).some((option) => option.value === selected)) {
      els.eventFilter.value = selected;
    }
  }

  function applyFilters() {
    const type = els.eventFilter.value;
    const query = els.searchInput.value.trim().toLowerCase();
    let visible = 0;
    for (const item of rendered) {
      const matchesType = !type || item.event.type === type;
      const matchesQuery = !query || item.searchText.includes(query);
      const show = matchesType && matchesQuery;
      item.node.classList.toggle("hidden", !show);
      if (show) visible++;
    }
    if (!rendered.length) ensureEmptyState();
    else if (!visible) setNotice("현재 필터 조건에 맞는 이벤트가 없습니다.", "warning");
  }

  function ensureEmptyState() {
    if (document.getElementById("emptyState")) return;
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.id = "emptyState";
    empty.textContent = "아직 수신된 이벤트가 없습니다.";
    els.eventStream.append(empty);
    els.emptyState = empty;
  }

  function formatTime(value) {
    if (!value) return "--:--:--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString("ko-KR", { hour12: false });
  }

  function formatSourceTimestamp(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "-";
    const millis = number < 100000000000 ? number * 1000 : number;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ko-KR", { hour12: false });
  }

  function setNotice(text, tone) {
    els.streamNotice.textContent = text;
    els.streamNotice.className = `notice${tone ? ` ${tone}` : ""}`;
  }

  els.pauseButton.addEventListener("click", () => {
    paused = !paused;
    els.pauseButton.textContent = paused ? "화면 재개" : "화면 일시정지";
    els.liveIndicator.classList.toggle("paused", paused);
    els.liveIndicator.lastChild.textContent = paused ? " PAUSED" : " LIVE";
    if (paused) {
      setNotice("화면 갱신만 일시정지했습니다. 브리지의 이벤트 수집은 계속됩니다.", "warning");
    } else {
      setNotice("누적된 새 이벤트를 다시 불러옵니다.", "");
      pollEvents();
    }
  });

  els.clearButton.addEventListener("click", () => {
    rendered.forEach((item) => item.node.remove());
    rendered = [];
    lastSequence = latestServerSequence;
    ensureEmptyState();
    setNotice("현재 화면을 비웠습니다. 이후 수신 이벤트부터 다시 표시합니다.", "");
  });

  els.eventFilter.addEventListener("change", applyFilters);
  els.searchInput.addEventListener("input", applyFilters);

  refreshState();
  pollEvents();
  setInterval(refreshState, 2000);
  setInterval(pollEvents, 700);
})();
