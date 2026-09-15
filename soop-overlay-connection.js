(() => {
  "use strict";

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || window.__rouletteSilentWebSocketInstalled) return;
  window.__rouletteSilentWebSocketInstalled = true;

  class SilentReconnectWebSocket extends EventTarget {
    static CONNECTING = NativeWebSocket.CONNECTING;
    static OPEN = NativeWebSocket.OPEN;
    static CLOSING = NativeWebSocket.CLOSING;
    static CLOSED = NativeWebSocket.CLOSED;

    constructor(url, protocols) {
      super();
      this.url = String(url);
      this.protocols = protocols;
      this.readyState = SilentReconnectWebSocket.CONNECTING;
      this.protocol = "";
      this.extensions = "";
      this._binaryType = "blob";
      this._inner = null;
      this._manualClose = false;
      this._retryTimer = null;
      this._retryAttempt = 0;
      this._connect();
    }

    get binaryType() { return this._binaryType; }
    set binaryType(value) {
      this._binaryType = value;
      if (this._inner) this._inner.binaryType = value;
    }

    get bufferedAmount() {
      return this._inner?.bufferedAmount || 0;
    }

    send(data) {
      if (!this._inner || this.readyState !== SilentReconnectWebSocket.OPEN) {
        throw new DOMException("WebSocket is not open", "InvalidStateError");
      }
      this._inner.send(data);
    }

    close(code, reason) {
      this._manualClose = true;
      if (this._retryTimer) {
        window.clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      this.readyState = SilentReconnectWebSocket.CLOSING;
      if (this._inner && this._inner.readyState < NativeWebSocket.CLOSING) {
        this._inner.close(code, reason);
      } else {
        this.readyState = SilentReconnectWebSocket.CLOSED;
      }
    }

    _connect() {
      if (this._manualClose) return;
      this.readyState = SilentReconnectWebSocket.CONNECTING;
      let socket;
      try {
        socket = this.protocols === undefined
          ? new NativeWebSocket(this.url)
          : new NativeWebSocket(this.url, this.protocols);
      } catch {
        this._scheduleReconnect();
        return;
      }
      this._inner = socket;
      socket.binaryType = this._binaryType;

      socket.addEventListener("open", () => {
        if (socket !== this._inner || this._manualClose) return;
        this.readyState = SilentReconnectWebSocket.OPEN;
        this.protocol = socket.protocol || "";
        this.extensions = socket.extensions || "";
        this._retryAttempt = 0;
        this.dispatchEvent(new Event("open"));
      });

      socket.addEventListener("message", (event) => {
        if (socket !== this._inner || this._manualClose) return;
        this._handleBridgeControl(event.data);
        this.dispatchEvent(new MessageEvent("message", {
          data: event.data,
          origin: event.origin,
          lastEventId: event.lastEventId
        }));
      });

      socket.addEventListener("close", (event) => {
        if (socket !== this._inner) return;
        this.readyState = SilentReconnectWebSocket.CLOSED;
        if (this._manualClose) {
          this.dispatchEvent(new CloseEvent("close", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean
          }));
          return;
        }
        this._scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        // Intentionally silent for the broadcast overlay. The close event drives reconnect.
      });
    }

    _handleBridgeControl(raw) {
      if (typeof raw !== "string") return;
      try {
        const payload = JSON.parse(raw);
        if (payload?.type !== "bridge.restart") return;
        if (payload.websocketUrl) this.url = String(payload.websocketUrl);
        window.dispatchEvent(new CustomEvent("roulette-overlay:bridge-config", {
          detail: {
            apiBase: payload.apiBase || null,
            websocketUrl: payload.websocketUrl || null,
            overlayUrl: payload.overlayUrl || null
          }
        }));
      } catch {
        // Non-JSON and normal ticket messages are handled by the overlay itself.
      }
    }

    _scheduleReconnect() {
      if (this._manualClose || this._retryTimer) return;
      const base = Math.min(5000, 600 * (2 ** Math.min(this._retryAttempt, 4)));
      const delay = base + Math.floor(Math.random() * 250);
      this._retryAttempt += 1;
      this._retryTimer = window.setTimeout(() => {
        this._retryTimer = null;
        this._connect();
      }, delay);
    }
  }

  for (const property of ["onopen", "onmessage", "onerror", "onclose"]) {
    Object.defineProperty(SilentReconnectWebSocket.prototype, property, {
      get() { return this[`_${property}`] || null; },
      set(handler) {
        const previous = this[`_${property}`];
        if (previous) this.removeEventListener(property.slice(2), previous);
        this[`_${property}`] = typeof handler === "function" ? handler : null;
        if (this[`_${property}`]) this.addEventListener(property.slice(2), this[`_${property}`]);
      }
    });
  }

  window.WebSocket = SilentReconnectWebSocket;
})();
