/**
 * WebSocket client for one permanent room.
 *
 *  - joins with the derived roomId (the code never leaves the browser)
 *  - reconnects with back-off and asks only for what it missed (afterSeq)
 *  - keeps un-acked sends and re-sends them after every reconnect; the
 *    client-generated msgId makes that safe (the server de-duplicates)
 *  - pings every 25 s so Cloudflare does not drop an idle socket (~100 s)
 */

export const CONNECTION = {
  CONNECTING: "connecting",
  LIVE: "live",
  RECONNECTING: "reconnecting",
  CLOSED: "closed",
};

const PING_INTERVAL_MS = 25_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const RATE_LIMIT_RETRY_MS = 3000;

export function createPermanentClient({ url, roomId, senderId, onStatus, onFrame }) {
  let ws = null;
  let status = CONNECTION.CONNECTING;
  let stopped = false;
  let attempts = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let lastSeq = 0;
  const pending = new Map(); // msgId -> { frame, resolve, reject }

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  }

  function rawSend(frame) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  function noteSeq(items) {
    for (const item of items) lastSeq = Math.max(lastSeq, item.seq);
  }

  function flushPending() {
    for (const { frame } of pending.values()) rawSend(frame);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay * (0.75 + Math.random() * 0.5));
  }

  function reconnectNow() {
    if (stopped || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connect();
  }

  function handleFrame(frame) {
    switch (frame.type) {
      case "joined":
        attempts = 0;
        setStatus(CONNECTION.LIVE);
        flushPending();
        break;
      case "messages":
        // "initial" replaces everything (also after a server restore from an older backup).
        if (frame.dir === "initial") lastSeq = 0;
        if (frame.dir !== "older") noteSeq(frame.items);
        break;
      case "message":
        noteSeq([frame.item]);
        break;
      case "ack": {
        const entry = pending.get(frame.msgId);
        if (entry) {
          pending.delete(frame.msgId);
          entry.resolve({ seq: frame.seq, ts: frame.ts });
        }
        return;
      }
      case "error": {
        const entry = frame.msgId ? pending.get(frame.msgId) : null;
        if (entry) {
          if (frame.code === "rate_limited") {
            setTimeout(() => !stopped && rawSend(entry.frame), RATE_LIMIT_RETRY_MS);
          } else {
            pending.delete(frame.msgId);
            entry.reject(Object.assign(new Error(frame.code), { code: frame.code }));
          }
          return;
        }
        break;
      }
      case "pong":
        return;
      default:
        break;
    }
    onFrame?.(frame);
  }

  function connect() {
    if (stopped) return;
    setStatus(attempts === 0 ? CONNECTION.CONNECTING : CONNECTION.RECONNECTING);

    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    const socket = ws;

    socket.onopen = () => {
      rawSend({
        type: "join",
        roomId,
        senderId,
        ...(lastSeq > 0 ? { afterSeq: lastSeq } : {}),
      });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => rawSend({ type: "ping" }), PING_INTERVAL_MS);
    };

    socket.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      handleFrame(frame);
    };

    socket.onclose = () => {
      if (socket !== ws) return;
      clearInterval(pingTimer);
      if (stopped) return;
      setStatus(CONNECTION.RECONNECTING);
      scheduleReconnect();
    };

    socket.onerror = () => socket.close();
  }

  function onVisible() {
    if (document.visibilityState === "visible") reconnectNow();
  }

  // A page parked in the back/forward cache keeps its socket open, which would show
  // as a phantom "online" member; drop it on the way out and reconnect on return.
  function onPageHide() {
    ws?.close();
  }

  function onPageShow(event) {
    if (event.persisted) reconnectNow();
  }

  return {
    start() {
      stopped = false;
      window.addEventListener("online", reconnectNow);
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
      connect();
    },

    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      for (const entry of pending.values()) {
        entry.reject(Object.assign(new Error("closed"), { code: "closed" }));
      }
      pending.clear();
      const socket = ws;
      ws = null;
      socket?.close();
      setStatus(CONNECTION.CLOSED);
    },

    // Resolves with { seq, ts } once the server has stored the message.
    send(frame) {
      return new Promise((resolve, reject) => {
        pending.set(frame.msgId, { frame, resolve, reject });
        if (status === CONNECTION.LIVE) rawSend(frame);
      });
    },

    requestOlder(beforeSeq, limit = 50) {
      rawSend({ type: "history", beforeSeq, limit });
    },

    sendRead(upToSeq) {
      rawSend({ type: "read", upToSeq });
    },

    sendTyping(sealed) {
      rawSend({ type: "typing", ...sealed });
    },

    getStatus: () => status,
  };
}
