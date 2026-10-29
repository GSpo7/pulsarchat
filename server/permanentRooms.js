import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocketServer } from "ws";
import { hashRoomId } from "./db.js";
import { getClientIp } from "./clientIp.js";
import { isOriginAllowed } from "./origin.js";
import { createRateLimiter } from "./rateLimit.js";

// The server never sees a room code or plaintext. `roomId` is derived in the
// browser from the code; `iv`/`ct` are AES-GCM output. Never log any of them.

const ROOM_ID_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding
const SENDER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IV_RE = /^[A-Za-z0-9+/]{16}$/; // 12 bytes, base64
const CT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_TYPING_CT_CHARS = 1024;
const MIN_CT_CHARS = 22; // at least the 16-byte GCM tag
const PAGE_SIZE = 50;
const MAX_HISTORY_PAGE = 100;
const CATCHUP_BATCH = 200;
const CATCHUP_MAX_GAP = 500;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

function base64DecodedBytes(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function defaultFreeDiskBytes(databasePath) {
  if (databasePath === ":memory:") return Infinity;
  try {
    const stats = statfsSync(dirname(databasePath));
    return stats.bavail * stats.bsize;
  } catch {
    return Infinity;
  }
}

export function createPermanentRooms({
  db,
  config,
  logger = console,
  freeDiskBytes = () => defaultFreeDiskBytes(config.databasePath),
}) {
  const { limits } = config;
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes });
  const rooms = new Map(); // hex(room hash) -> Set<ws>

  const connectionLimiter = createRateLimiter({
    limit: limits.connectionsPerMinutePerIp,
    windowMs: 60_000,
  });
  const newRoomLimiter = createRateLimiter({
    limit: limits.newRoomsPerHourPerIp,
    windowMs: 3_600_000,
  });

  function send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function sendError(ws, code, msgId) {
    send(ws, msgId ? { type: "error", code, msgId } : { type: "error", code });
  }

  function broadcast(key, payload, except = null) {
    const members = rooms.get(key);
    if (!members) return;
    for (const member of members) {
      if (member !== except) send(member, payload);
    }
  }

  function broadcastPresence(key) {
    const members = rooms.get(key);
    if (!members) return;
    broadcast(key, { type: "presence", online: members.size });
  }

  function sendInitial(ws) {
    const page = db.listLatest(ws.room.hash, { limit: PAGE_SIZE });
    send(ws, { type: "messages", dir: "initial", ...page });
  }

  function onJoin(ws, msg) {
    if (ws.room) return sendError(ws, "bad_request");
    if (!ROOM_ID_RE.test(msg.roomId ?? "") || !SENDER_ID_RE.test(msg.senderId ?? "")) {
      return sendError(ws, "bad_request");
    }

    const roomBytes = Buffer.from(msg.roomId, "base64url");
    if (roomBytes.length !== 32) return sendError(ws, "bad_request");

    const hash = hashRoomId(roomBytes);
    const key = hash.toString("hex");
    ws.room = { hash, key };
    ws.senderId = msg.senderId;

    let members = rooms.get(key);
    if (!members) {
      members = new Set();
      rooms.set(key, members);
    }
    members.add(ws);

    const lastSeq = db.lastSeq(hash);
    send(ws, { type: "joined", lastSeq, online: members.size });

    const afterSeq = msg.afterSeq;
    const canCatchUp =
      Number.isInteger(afterSeq) &&
      afterSeq >= 0 &&
      afterSeq <= lastSeq &&
      lastSeq - afterSeq <= CATCHUP_MAX_GAP;

    if (canCatchUp) {
      let cursor = afterSeq;
      for (;;) {
        const page = db.listAfter(hash, cursor, CATCHUP_BATCH);
        send(ws, { type: "messages", dir: "newer", ...page });
        if (!page.hasMore) break;
        cursor = page.items[page.items.length - 1].seq;
      }
    } else {
      // First join, a very long gap, or the server DB was restored from an
      // older backup: the client replaces what it has.
      sendInitial(ws);
    }

    broadcastPresence(key);
  }

  function onSend(ws, msg) {
    if (!ws.room) return sendError(ws, "bad_request");
    const { msgId, iv, ct, kind } = msg;
    if (
      !MSG_ID_RE.test(msgId ?? "") ||
      !IV_RE.test(iv ?? "") ||
      typeof ct !== "string" ||
      ct.length < MIN_CT_CHARS ||
      (kind !== "text" && kind !== "image")
    ) {
      return sendError(ws, "bad_request", typeof msgId === "string" ? msgId : undefined);
    }

    const maxBytes = kind === "image" ? limits.maxImageBytes : limits.maxTextBytes;
    if (base64DecodedBytes(ct) > maxBytes) return sendError(ws, "too_large", msgId);
    if (!CT_RE.test(ct)) return sendError(ws, "bad_request", msgId);

    const { hash, key } = ws.room;

    if (!db.roomExists(hash)) {
      if (!newRoomLimiter.hit(ws.ip)) return sendError(ws, "rate_limited", msgId);
      if (freeDiskBytes() < limits.minFreeDiskBytes) {
        logger.error("[permanent] refusing new room: low disk space");
        return sendError(ws, "unavailable", msgId);
      }
    }

    let result;
    try {
      result = db.appendMessage(hash, { msgId, senderId: ws.senderId, iv, ct });
    } catch (error) {
      if (error.code === "quota") return sendError(ws, "quota", msgId);
      logger.error("[permanent] database error:", error.message);
      return sendError(ws, "server_error", msgId);
    }

    send(ws, { type: "ack", msgId, seq: result.seq, ts: result.ts });
    if (!result.duplicate) {
      broadcast(
        key,
        {
          type: "message",
          item: {
            seq: result.seq,
            msgId,
            senderId: ws.senderId,
            ts: result.ts,
            iv,
            ct,
          },
        },
        ws,
      );
    }
  }

  function onHistory(ws, msg) {
    if (!ws.room) return sendError(ws, "bad_request");
    if (!Number.isInteger(msg.beforeSeq) || msg.beforeSeq < 1) {
      return sendError(ws, "bad_request");
    }
    const limit = Math.min(
      Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : PAGE_SIZE,
      MAX_HISTORY_PAGE,
    );
    const page = db.listLatest(ws.room.hash, { beforeSeq: msg.beforeSeq, limit });
    send(ws, { type: "messages", dir: "older", ...page });
  }

  function onTyping(ws, msg) {
    if (!ws.room) return;
    if (!IV_RE.test(msg.iv ?? "") || typeof msg.ct !== "string") return;
    if (msg.ct.length > MAX_TYPING_CT_CHARS || !CT_RE.test(msg.ct)) return;
    broadcast(
      ws.room.key,
      { type: "typing", senderId: ws.senderId, iv: msg.iv, ct: msg.ct },
      ws,
    );
  }

  wss.on("connection", (ws, req, ip) => {
    ws.ip = ip;
    ws.room = null;
    ws.senderId = null;
    ws.lastSeen = Date.now();

    let windowCount = 0;
    let windowReset = Date.now() + 10_000;

    logger.log(`[permanent] connected (total: ${wss.clients.size})`);

    ws.on("message", (data, isBinary) => {
      ws.lastSeen = Date.now();
      if (isBinary) return sendError(ws, "bad_request");

      if (ws.lastSeen > windowReset) {
        windowCount = 0;
        windowReset = ws.lastSeen + 10_000;
      }
      windowCount++;

      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return sendError(ws, "bad_request");
      }
      if (!msg || typeof msg !== "object") return sendError(ws, "bad_request");

      if (msg.type === "ping") return send(ws, { type: "pong" });
      if (windowCount > limits.socketMessagesPer10s) {
        return sendError(ws, "rate_limited", typeof msg.msgId === "string" ? msg.msgId : undefined);
      }

      try {
        if (msg.type === "join") onJoin(ws, msg);
        else if (msg.type === "send") onSend(ws, msg);
        else if (msg.type === "history") onHistory(ws, msg);
        else if (msg.type === "typing") onTyping(ws, msg);
        else sendError(ws, "bad_request");
      } catch (error) {
        logger.error("[permanent] handler error:", error.message);
        sendError(ws, "server_error");
      }
    });

    const cleanup = () => {
      if (!ws.room) return;
      const { key } = ws.room;
      ws.room = null;
      const members = rooms.get(key);
      if (!members) return;
      members.delete(ws);
      if (members.size === 0) rooms.delete(key);
      else broadcastPresence(key);
    };

    ws.on("close", () => {
      cleanup();
      logger.log(`[permanent] disconnected (total: ${wss.clients.size})`);
    });
    ws.on("error", cleanup);
  });

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (now - ws.lastSeen > limits.idleTimeoutMs) ws.terminate();
    }
  }, 30_000);
  idleSweep.unref();

  function reject(socket, status, reason) {
    logger.warn(`[permanent] rejected upgrade: ${reason}`);
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  return {
    handleUpgrade(req, socket, head) {
      if (!isOriginAllowed(req.headers.origin, config)) {
        return reject(socket, "403 Forbidden", "origin");
      }
      const ip = getClientIp(req, config.trustProxy);
      if (!connectionLimiter.hit(ip)) {
        return reject(socket, "429 Too Many Requests", "connection rate limit");
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, ip));
    },

    onlineCount: () => wss.clients.size,

    close() {
      clearInterval(idleSweep);
      connectionLimiter.close();
      newRoomLimiter.close();
      for (const ws of wss.clients) ws.close(1001, "server restarting");
      wss.close();
    },
  };
}
