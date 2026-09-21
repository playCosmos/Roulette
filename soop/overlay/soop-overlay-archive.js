(() => {
  "use strict";

  const MAX_ATTEMPTS = 8;
  let uploadChain = Promise.resolve();
  let dynamicApiBase = null;

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function resolveApiBase() {
    if (dynamicApiBase) return dynamicApiBase.replace(/\/+$/, "");
    const params = new URLSearchParams(location.search);
    const configured = params.get("api");
    if (configured) return configured.replace(/\/+$/, "");

    if (location.hostname.endsWith("github.io")) return null;
    if (location.protocol === "http:" || location.protocol === "https:") return location.origin;
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

  async function retryRequest(request) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await request();
      } catch (error) {
        lastError = error;
        if (error?.nonRetryable || attempt === MAX_ATTEMPTS) break;
        await sleep(Math.min(3000, 500 * (2 ** (attempt - 1))));
      }
    }
    throw lastError;
  }

  async function acknowledgeCompleted(ticket) {
    if (!ticket?.ticketId || String(ticket.ticketId).startsWith("TEST-")) {
      return { skipped: true, reason: "debug-ticket" };
    }

    return retryRequest(async () => {
      const apiBase = resolveApiBase();
      if (!apiBase) return { skipped: true, reason: "bridge-api-unavailable" };
      const endpoint = `${apiBase}/api/tickets/${encodeURIComponent(ticket.ticketId)}/completed`;
      const response = await fetch(endpoint, { method: "POST", cache: "no-store" });
      if (!response.ok) {
        const error = new Error(`룰렛 완료 상태 저장 실패 (${response.status})`);
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          throw Object.assign(error, { nonRetryable: true });
        }
        throw error;
      }
      return response.json().catch(() => ({}));
    });
  }

  async function uploadTicket(ticket, dataUrl) {
    if (!ticket?.ticketId || String(ticket.ticketId).startsWith("TEST-")) {
      return { skipped: true, reason: "debug-ticket" };
    }

    const blob = await dataUrlToPngBlob(dataUrl);
    try {
      const result = await retryRequest(async () => {
        const apiBase = resolveApiBase();
        if (!apiBase) throw new Error("bridge API unavailable");
        const endpoint = `${apiBase}/api/tickets/${encodeURIComponent(ticket.ticketId)}/image`;
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
        try { return body ? JSON.parse(body) : {}; }
        catch { return { raw: body }; }
      });

      window.dispatchEvent(new CustomEvent("roulette-overlay:archive-saved", {
        detail: { ticket, result }
      }));
      return result;
    } catch (error) {
      console.error("티켓 PNG 자동 저장 실패", error, ticket);
      window.dispatchEvent(new CustomEvent("roulette-overlay:archive-failed", {
        detail: { ticket, error: String(error?.message || error) }
      }));
      throw error;
    }
  }

  window.addEventListener("roulette-overlay:bridge-config", (event) => {
    const nextBase = event.detail?.apiBase;
    if (nextBase) dynamicApiBase = String(nextBase).replace(/\/+$/, "");
  });

  window.addEventListener("roulette-overlay:completed", (event) => {
    const ticket = event.detail;
    const dataUrl = document.getElementById("ticketPreview")?.src || "";
    uploadChain = uploadChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await acknowledgeCompleted(ticket);
        } catch (error) {
          console.warn("룰렛 완료 acknowledgement 실패. PNG 저장은 계속 시도합니다.", error);
        }
        return uploadTicket(ticket, dataUrl);
      })
      .catch(() => undefined);
  });

  window.RouletteOverlayArchive = Object.freeze({
    acknowledgeCompleted,
    uploadTicket,
    resolveApiBase,
    version: "1.2.0"
  });
})();
