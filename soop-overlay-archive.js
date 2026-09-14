(() => {
  "use strict";

  const MAX_ATTEMPTS = 3;
  let uploadChain = Promise.resolve();

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function resolveApiBase() {
    const params = new URLSearchParams(location.search);
    const configured = params.get("api");
    if (configured) return configured.replace(/\/+$/, "");

    if (location.hostname.endsWith("github.io")) return null;
    if (location.protocol === "http:" || location.protocol === "https:") {
      return location.origin;
    }
    return null;
  }

  async function dataUrlToPngBlob(dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
      throw new Error("렌더링된 PNG data URL을 찾을 수 없습니다.");
    }
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    if (blob.type && blob.type !== "image/png") {
      throw new Error(`잘못된 티켓 이미지 형식: ${blob.type}`);
    }
    return blob;
  }

  async function uploadTicket(ticket, dataUrl) {
    const apiBase = resolveApiBase();
    if (!apiBase) return { skipped: true, reason: "bridge-api-unavailable" };
    if (!ticket?.ticketId || String(ticket.ticketId).startsWith("TEST-")) {
      return { skipped: true, reason: "debug-ticket" };
    }

    const blob = await dataUrlToPngBlob(dataUrl);
    const endpoint = `${apiBase}/api/tickets/${encodeURIComponent(ticket.ticketId)}/image`;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: blob,
          cache: "no-store"
        });

        const body = await response.text();
        if (!response.ok) {
          const error = new Error(`티켓 저장 실패 (${response.status}): ${body || response.statusText}`);
          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw Object.assign(error, { nonRetryable: true });
          }
          throw error;
        }

        let result = {};
        try { result = body ? JSON.parse(body) : {}; } catch { result = { raw: body }; }
        window.dispatchEvent(new CustomEvent("roulette-overlay:archive-saved", {
          detail: { ticket, result }
        }));
        return result;
      } catch (error) {
        lastError = error;
        if (error?.nonRetryable || attempt === MAX_ATTEMPTS) break;
        await sleep(400 * (2 ** (attempt - 1)));
      }
    }

    console.error("티켓 PNG 자동 저장 실패", lastError, ticket);
    window.dispatchEvent(new CustomEvent("roulette-overlay:archive-failed", {
      detail: { ticket, error: String(lastError?.message || lastError) }
    }));
    throw lastError;
  }

  window.addEventListener("roulette-overlay:completed", (event) => {
    const ticket = event.detail;
    const dataUrl = document.getElementById("ticketPreview")?.src || "";
    uploadChain = uploadChain
      .catch(() => undefined)
      .then(() => uploadTicket(ticket, dataUrl))
      .catch(() => undefined);
  });

  window.RouletteOverlayArchive = Object.freeze({
    uploadTicket,
    resolveApiBase,
    version: "1.0.0"
  });
})();
