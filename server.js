import { createServer } from "http";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import express from "express";
import { ExpressPeerServer } from "peer";
import { WebSocketServer } from "ws";
import { parse } from "url";
import admin from "firebase-admin";
import { loadConfig } from "./server/config.js";
import { getClientIp } from "./server/clientIp.js";
import { isOriginAllowed } from "./server/origin.js";
import { openDatabase } from "./server/db.js";
import { createPermanentRooms } from "./server/permanentRooms.js";

const config = loadConfig();
const port = config.port;
const app = express();
const server = createServer(app);
const distDir = join(dirname(fileURLToPath(import.meta.url)), "dist");

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// ── Permanent rooms (stored, end-to-end encrypted) ──────────
const db = openDatabase(config.databasePath, {
  roomMaxBytes: config.limits.roomMaxBytes,
  pageMaxBytes: config.limits.pageMaxBytes,
});
const permanentRooms = createPermanentRooms({ db, config });

// ── PeerJS (uses Express middleware only, no auto-upgrade) ──
const dummyServer = createServer();
const peerServer = ExpressPeerServer(dummyServer, { path: "/", proxied: true });
app.use("/peerjs", peerServer);

// ── Notification WebSocket ──────────────────────────────────
const handles = new Map();
const handleTokens = new Map(); // handle → token (prevents hijacking)
const pushTokens = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });

// ── Connection rate limiting ────────────────────────────────
const connectionRates = new Map();
const MAX_CONNECTIONS_PER_MINUTE = 10;

// Initialize Firebase Admin from environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (serviceAccount.project_id) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("[firebase] initialized");
} else {
  console.warn("[firebase] no service account — push notifications disabled");
}

wss.on("connection", (ws, handle) => {
  handles.set(handle, ws);
  console.log(`[notify] connected (total: ${handles.size})`);

  let msgCount = 0;
  let msgResetTime = Date.now() + 10000;
  const MAX_MESSAGES_PER_10S = 50;

  ws.on("message", (raw) => {
    const now = Date.now();
    if (now > msgResetTime) {
      msgCount = 0;
      msgResetTime = now + 10000;
    }
    msgCount++;
    if (msgCount > MAX_MESSAGES_PER_10S) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "ping") {
      const chatMode = msg.chatMode === "saved" ? "saved" : "ghost";
      const target = handles.get(msg.to);
      if (target && target.readyState === ws.OPEN) {
        target.send(
          JSON.stringify({
            type: "ping",
            from: msg.from,
            room: msg.room,
            chatMode,
          }),
        );
      } else {
        const pushToken = pushTokens.get(msg.to);
        if (pushToken && admin.apps.length > 0) {
          admin
            .messaging()
            .send({
              token: pushToken,
              notification: {
                title: "pulsarchat",
                body: `${msg.from} wants to chat`,
              },
              data: {
                type: "ping",
                senderHandle: msg.from,
                room: msg.room,
                chatMode,
              },
              android: {
                priority: "high",
                notification: {
                  channelId: "pulsarchat_pings",
                  icon: "ic_launcher",
                },
              },
            })
            .then(() => {
              console.log("[push] notification sent");
            })
            .catch((err) => {
              console.error("[push] notification failed:", err.message);
              pushTokens.delete(msg.to);
            });
        }
      }
    } else if (msg.type === "register-push-token") {
      if (msg.token && handle) {
        pushTokens.set(handle, msg.token);
      }
    } else if (msg.type === "status") {
      const online = (msg.handles || []).filter((h) => {
        const c = handles.get(h);
        return c && c.readyState === ws.OPEN;
      });
      ws.send(JSON.stringify({ type: "status", online }));
    }
  });

  ws.on("close", () => {
    handles.delete(handle);
    handleTokens.delete(handle);
    console.log(`[notify] disconnected (total: ${handles.size})`);
  });

  ws.on("error", () => {
    handles.delete(handle);
    handleTokens.delete(handle);
  });
});

// ── Single upgrade handler — we control all WebSocket upgrades ──
server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parse(req.url, true);

  if (pathname === "/notify") {
    const rejectUpgrade = (reason) => {
      console.warn(`[notify] rejected upgrade: ${reason}`);
      socket.destroy();
    };

    if (!isOriginAllowed(req.headers.origin, config)) {
      rejectUpgrade(`origin ${req.headers.origin}`);
      return;
    }

    // Require handle and token
    const handle = query.handle;
    const token = query.token;
    if (!handle || !token) {
      rejectUpgrade("missing handle or token");
      return;
    }

    // Token auth: reject if a different token is already registered for this handle
    const existingToken = handleTokens.get(handle);
    if (existingToken && existingToken !== token) {
      rejectUpgrade(`token mismatch for ${handle}`);
      return;
    }

    // Per-IP connection rate limit (real client IP, not the proxy's)
    const ip = getClientIp(req, config.trustProxy);
    const now = Date.now();
    const rate = connectionRates.get(ip) || { count: 0, reset: now + 60000 };
    if (now > rate.reset) {
      rate.count = 0;
      rate.reset = now + 60000;
    }
    rate.count++;
    connectionRates.set(ip, rate);
    if (rate.count > MAX_CONNECTIONS_PER_MINUTE) {
      rejectUpgrade(`rate limit for ${ip}`);
      return;
    }

    handleTokens.set(handle, token);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, handle);
    });
  } else if (pathname === "/permanent") {
    permanentRooms.handleUpgrade(req, socket, head);
  } else if (pathname.startsWith("/peerjs")) {
    dummyServer.emit("upgrade", req, socket, head);
  } else {
    console.warn(`[ws] rejected upgrade: ${pathname}`);
    socket.destroy();
  }
});

// Stale rate-limit entries would otherwise accumulate forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rate] of connectionRates) {
    if (now > rate.reset) connectionRates.delete(ip);
  }
}, 60000).unref();

// ── Health + stats ──────────────────────────────────────────
app.get("/api/health", (req, res) => {
  try {
    db.ping();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get("/stats", (req, res) => {
  const secret = process.env.STATS_SECRET;
  if (!secret || req.query.key !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.json({
    activeUsers: handles.size,
    permanentConnections: permanentRooms.onlineCount(),
  });
});

// ── Built frontend (single origin: site + signalling + rooms) ──
if (existsSync(distDir)) {
  app.use(
    express.static(distDir, {
      index: false,
      setHeaders(res, filePath) {
        // Vite fingerprints everything in /assets, so it is safe to cache forever.
        if (filePath.includes(`${join(distDir, "assets")}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/peerjs")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(join(distDir, "index.html"));
  });
} else {
  console.warn("[http] dist/ not found — run `npm run build` to serve the site");
}

server.listen(port, config.host, () => {
  console.log(
    `PulsarChat server running on ${config.host || "0.0.0.0"}:${port} (db: ${config.databasePath})`,
  );
});

function shutdown() {
  console.log("[server] shutting down");
  permanentRooms.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
