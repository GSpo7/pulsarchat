import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { openDatabase } from "../server/db.js";
import { createPermanentRooms } from "../server/permanentRooms.js";

const quiet = { log() {}, warn() {}, error() {} };

function baseConfig(overrides = {}) {
  return {
    isProduction: false,
    trustProxy: false,
    allowedOrigins: [],
    databasePath: "",
    ...overrides,
    limits: {
      roomMaxBytes: 1024 * 1024,
      maxTextBytes: 2048,
      maxImageBytes: 8192,
      maxAudioBytes: 4096,
      pageMaxBytes: 1024 * 1024,
      minFreeDiskBytes: 0,
      maxFrameBytes: 16384,
      socketMessagesPer10s: 20,
      connectionsPerMinutePerIp: 1000,
      newRoomsPerHourPerIp: 1000,
      idleTimeoutMs: 90_000,
      ...overrides.limits,
    },
  };
}

const running = new Set();

async function startServer(dbPath, configOverrides = {}) {
  const config = baseConfig({ ...configOverrides, databasePath: dbPath });
  const db = openDatabase(dbPath, {
    roomMaxBytes: config.limits.roomMaxBytes,
    pageMaxBytes: config.limits.pageMaxBytes,
  });
  const rooms = createPermanentRooms({ db, config, logger: quiet, freeDiskBytes: () => Infinity });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const handle = {
    url: `ws://127.0.0.1:${port}/permanent`,
    async stop() {
      if (!running.delete(handle)) return;
      rooms.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
  running.add(handle);
  return handle;
}

// A tiny client that records every frame and lets tests await specific ones.
async function connect(url, options = {}) {
  const ws = new WebSocket(url, options);
  const frames = [];
  const waiters = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    frames.push(frame);
    for (const w of [...waiters]) {
      if (w.predicate(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return {
    ws,
    frames,
    send: (obj) => ws.send(JSON.stringify(obj)),
    next(predicate, timeoutMs = 2000) {
      const hit = frames.find(predicate);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { predicate, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs).unref();
      });
    },
    close: () => new Promise((resolve) => (ws.once("close", resolve), ws.close())),
  };
}

const newRoomId = () => randomBytes(32).toString("base64url");
const senderId = (n) => `device-${n}-${randomBytes(4).toString("hex")}`;
let counter = 0;
const out = (text = "hello") => ({
  type: "send",
  kind: "text",
  msgId: `m_${++counter}_${randomBytes(3).toString("hex")}`,
  iv: randomBytes(12).toString("base64"),
  ct: Buffer.from(text.padEnd(20, "_")).toString("base64"),
});

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pulsar-ws-"));
    try {
      await fn(join(dir, "t.db"));
    } finally {
      // a failed assertion must not leave servers open (it would hang the run)
      await Promise.all([...running].map((srv) => srv.stop()));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
}

test("live relay, ack, presence", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath);
  const roomId = newRoomId();
  const a = await connect(srv.url);
  const b = await connect(srv.url);
  a.send({ type: "join", roomId, senderId: senderId("a") });
  b.send({ type: "join", roomId, senderId: senderId("b") });
  await a.next((f) => f.type === "joined");
  await b.next((f) => f.type === "joined");
  await a.next((f) => f.type === "presence" && f.online === 2);

  const m = out("hi from a");
  a.send(m);
  const ack = await a.next((f) => f.type === "ack");
  assert.equal(ack.msgId, m.msgId);
  assert.equal(ack.seq, 1);
  const live = await b.next((f) => f.type === "message");
  assert.equal(live.item.ct, m.ct);
  assert.equal(live.item.seq, 1);
  // the sender does not receive its own message back
  assert.equal(a.frames.some((f) => f.type === "message"), false);

  await a.close();
  await b.close();
  await srv.stop();
}));

test("rooms are isolated by room id", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath);
  const a = await connect(srv.url);
  const b = await connect(srv.url);
  a.send({ type: "join", roomId: newRoomId(), senderId: senderId("a") });
  b.send({ type: "join", roomId: newRoomId(), senderId: senderId("b") });
  await a.next((f) => f.type === "joined");
  await b.next((f) => f.type === "joined");
  a.send(out());
  await a.next((f) => f.type === "ack");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.frames.some((f) => f.type === "message"), false);
  await a.close();
  await b.close();
  await srv.stop();
}));

test("offline user catches up after reconnect without duplicates", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath);
  const roomId = newRoomId();
  const a = await connect(srv.url);
  a.send({ type: "join", roomId, senderId: senderId("a") });
  await a.next((f) => f.type === "joined");

  const b1 = await connect(srv.url);
  b1.send({ type: "join", roomId, senderId: senderId("b") });
  await b1.next((f) => f.type === "joined");
  a.send(out("one"));
  await b1.next((f) => f.type === "message" && f.item.seq === 1);
  await b1.close();

  a.send(out("two"));
  a.send(out("three"));
  await a.next((f) => f.type === "ack" && f.seq === 3);

  const b2 = await connect(srv.url);
  b2.send({ type: "join", roomId, senderId: senderId("b"), afterSeq: 1 });
  const page = await b2.next((f) => f.type === "messages");
  assert.equal(page.dir, "newer");
  assert.deepEqual(page.items.map((i) => i.seq), [2, 3]);

  await a.close();
  await b2.close();
  await srv.stop();
}));

test("a fresh join gets the latest page and can page back", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath, { limits: { socketMessagesPer10s: 1000 } });
  const roomId = newRoomId();
  const a = await connect(srv.url);
  a.send({ type: "join", roomId, senderId: senderId("a") });
  await a.next((f) => f.type === "joined");
  for (let i = 1; i <= 60; i++) {
    a.send(out(`msg ${i}`));
    await a.next((f) => f.type === "ack" && f.seq === i);
  }
  const c = await connect(srv.url);
  c.send({ type: "join", roomId, senderId: senderId("c") });
  const initial = await c.next((f) => f.type === "messages");
  assert.equal(initial.dir, "initial");
  assert.equal(initial.items.length, 50);
  assert.equal(initial.items[0].seq, 11);
  assert.equal(initial.hasMore, true);

  c.send({ type: "history", beforeSeq: 11, limit: 100 });
  const older = await c.next((f) => f.type === "messages" && f.dir === "older");
  assert.deepEqual(older.items.map((i) => i.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(older.hasMore, false);

  await a.close();
  await c.close();
  await srv.stop();
}));

test("resending the same msgId after reconnect does not duplicate", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath);
  const roomId = newRoomId();
  const m = out("once");

  const a1 = await connect(srv.url);
  a1.send({ type: "join", roomId, senderId: "device-a-0001" });
  await a1.next((f) => f.type === "joined");
  a1.send(m);
  const first = await a1.next((f) => f.type === "ack");
  await a1.close();

  const a2 = await connect(srv.url);
  a2.send({ type: "join", roomId, senderId: "device-a-0001", afterSeq: 1 });
  await a2.next((f) => f.type === "joined");
  a2.send(m);
  const second = await a2.next((f) => f.type === "ack");
  assert.equal(second.seq, first.seq);

  const c = await connect(srv.url);
  c.send({ type: "join", roomId, senderId: senderId("c") });
  const initial = await c.next((f) => f.type === "messages");
  assert.equal(initial.items.length, 1);

  await a2.close();
  await c.close();
  await srv.stop();
}));

test("acknowledged messages survive a server restart", withTempDb(async (dbPath) => {
  const roomId = newRoomId();
  let srv = await startServer(dbPath);
  const a = await connect(srv.url);
  a.send({ type: "join", roomId, senderId: senderId("a") });
  await a.next((f) => f.type === "joined");
  a.send(out("durable"));
  await a.next((f) => f.type === "ack");
  await srv.stop();

  srv = await startServer(dbPath);
  const b = await connect(srv.url);
  b.send({ type: "join", roomId, senderId: senderId("b") });
  const joined = await b.next((f) => f.type === "joined");
  assert.equal(joined.lastSeq, 1);
  const initial = await b.next((f) => f.type === "messages");
  assert.equal(initial.items.length, 1);
  await b.close();
  await srv.stop();
}));

test("typing is relayed but never stored", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath);
  const roomId = newRoomId();
  const a = await connect(srv.url);
  const b = await connect(srv.url);
  a.send({ type: "join", roomId, senderId: senderId("a") });
  b.send({ type: "join", roomId, senderId: senderId("b") });
  await a.next((f) => f.type === "joined");
  await b.next((f) => f.type === "joined");
  a.send({ type: "typing", iv: randomBytes(12).toString("base64"), ct: randomBytes(24).toString("base64") });
  await b.next((f) => f.type === "typing");

  const c = await connect(srv.url);
  c.send({ type: "join", roomId, senderId: senderId("c") });
  const initial = await c.next((f) => f.type === "messages");
  assert.equal(initial.items.length, 0);
  await a.close();
  await b.close();
  await c.close();
  await srv.stop();
}));

test("bad input is rejected without crashing the server", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath);
  const a = await connect(srv.url);
  a.ws.send("not json at all");
  await a.next((f) => f.type === "error" && f.code === "bad_request");
  a.send({ type: "send", ...out() }); // not joined yet
  await a.next((f) => f.type === "error" && f.code === "bad_request");
  a.send({ type: "join", roomId: "short", senderId: senderId("a") });
  await a.next((f) => f.type === "error" && f.code === "bad_request");
  a.send({ type: "join", roomId: newRoomId(), senderId: senderId("a") });
  await a.next((f) => f.type === "joined");

  const big = out();
  big.ct = Buffer.alloc(4096, 1).toString("base64"); // > maxTextBytes (2048)
  a.send(big);
  const err = await a.next((f) => f.type === "error" && f.code === "too_large");
  assert.equal(err.msgId, big.msgId);

  const badIv = { ...out(), iv: "nope" };
  a.send(badIv);
  await a.next((f) => f.type === "error" && f.msgId === badIv.msgId);

  // still healthy
  a.send(out());
  await a.next((f) => f.type === "ack");
  await a.close();
  await srv.stop();
}));

test("per-socket rate limit", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath);
  const a = await connect(srv.url);
  a.send({ type: "join", roomId: newRoomId(), senderId: senderId("a") });
  await a.next((f) => f.type === "joined");
  for (let i = 0; i < 40; i++) a.send(out());
  await a.next((f) => f.type === "error" && f.code === "rate_limited");
  await a.close();
  await srv.stop();
}));

test("room quota returns an error and keeps existing messages", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath, { limits: { roomMaxBytes: 600 } });
  const roomId = newRoomId();
  const a = await connect(srv.url);
  a.send({ type: "join", roomId, senderId: senderId("a") });
  await a.next((f) => f.type === "joined");
  let quotaHit = false;
  for (let i = 0; i < 6 && !quotaHit; i++) {
    const m = out("x".repeat(60));
    a.send(m);
    const reply = await a.next((f) => f.msgId === m.msgId);
    if (reply.type === "error") {
      assert.equal(reply.code, "quota");
      quotaHit = true;
    }
  }
  assert.equal(quotaHit, true);
  const c = await connect(srv.url);
  c.send({ type: "join", roomId, senderId: senderId("c") });
  const initial = await c.next((f) => f.type === "messages");
  assert.ok(initial.items.length >= 1);
  await a.close();
  await c.close();
  await srv.stop();
}));

test("foreign Origin is rejected, allowed Origin and no Origin are accepted", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath, {
    isProduction: true,
    allowedOrigins: ["https://chat.example.com"],
  });
  await assert.rejects(connect(srv.url, { headers: { Origin: "https://evil.example.net" } }), /403/);
  await assert.rejects(
    connect(srv.url, { headers: { Origin: "https://chat.example.com.evil.net" } }),
    /403/,
  );
  const ok = await connect(srv.url, { headers: { Origin: "https://chat.example.com" } });
  await ok.close();
  const none = await connect(srv.url);
  await none.close();
  await srv.stop();
}));

test("connection rate limit uses CF-Connecting-IP only when proxy is trusted", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath, {
    trustProxy: true,
    limits: { connectionsPerMinutePerIp: 2 },
  });
  const open = (ip) => connect(srv.url, { headers: { "CF-Connecting-IP": ip } });
  const c1 = await open("203.0.113.1");
  const c2 = await open("203.0.113.1");
  await assert.rejects(open("203.0.113.1"), /429/);
  const other = await open("203.0.113.2"); // different visitor behind the same proxy
  await Promise.all([c1.close(), c2.close(), other.close()]);
  await srv.stop();
}));

test("audio messages use their own size limit", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath);
  const a = await connect(srv.url);
  a.send({ type: "join", roomId: newRoomId(), senderId: senderId("a") });
  await a.next((f) => f.type === "joined");

  const voice = { ...out(), kind: "audio", ct: Buffer.alloc(3000, 1).toString("base64") };
  a.send(voice);
  await a.next((f) => f.type === "ack" && f.msgId === voice.msgId);

  // 3000 bytes is over the text limit (2048) but fine for audio (4096)
  const asText = { ...out(), ct: voice.ct };
  a.send(asText);
  await a.next((f) => f.type === "error" && f.code === "too_large" && f.msgId === asText.msgId);

  const tooLong = { ...out(), kind: "audio", ct: Buffer.alloc(5000, 1).toString("base64") };
  a.send(tooLong);
  await a.next((f) => f.type === "error" && f.code === "too_large" && f.msgId === tooLong.msgId);
  await a.close();
  await srv.stop();
}));

test("history pages stop at the byte budget, and big gaps fall back to the latest page", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath, { limits: { pageMaxBytes: 6000, maxImageBytes: 4000 } });
  const roomId = newRoomId();
  const a = await connect(srv.url);
  a.send({ type: "join", roomId, senderId: senderId("a") });
  await a.next((f) => f.type === "joined");

  // seven 3000-byte photos: a 6000-byte page holds two, never three
  for (let i = 0; i < 7; i++) {
    const photo = { ...out(), kind: "image", ct: Buffer.alloc(3000, i + 1).toString("base64") };
    a.send(photo);
    await a.next((f) => f.type === "ack" && f.msgId === photo.msgId);
  }
  await a.close();

  const b = await connect(srv.url);
  b.send({ type: "join", roomId, senderId: senderId("b") });
  const initial = await b.next((f) => f.type === "messages" && f.dir === "initial");
  assert.equal(initial.items.length, 2);
  assert.equal(initial.hasMore, true);
  assert.deepEqual(initial.items.map((m) => m.seq), [6, 7]);

  b.send({ type: "history", beforeSeq: 6, limit: 50 });
  const older = await b.next((f) => f.type === "messages" && f.dir === "older");
  assert.deepEqual(older.items.map((m) => m.seq), [4, 5]);
  assert.equal(older.hasMore, true);
  await b.close();

  // 7 photos missed is more than three pages of budget: the client gets the latest page instead
  const c = await connect(srv.url);
  c.send({ type: "join", roomId, senderId: senderId("c"), afterSeq: 0 });
  const replaced = await c.next((f) => f.type === "messages");
  assert.equal(replaced.dir, "initial");
  await c.close();
  await srv.stop();
}));

test("read receipts: live, stored, forward-only, and returned with history", withTempDb(async (dbPath) => {
  const srv = await startServer(dbPath);
  const roomId = newRoomId();
  const idA = senderId("a");
  const idB = senderId("b");
  const a = await connect(srv.url);
  const b = await connect(srv.url);
  a.send({ type: "join", roomId, senderId: idA });
  b.send({ type: "join", roomId, senderId: idB });
  await a.next((f) => f.type === "joined");
  await b.next((f) => f.type === "joined");

  const first = out("one");
  const second = out("two");
  a.send(first);
  await a.next((f) => f.type === "ack" && f.msgId === first.msgId);
  a.send(second);
  await a.next((f) => f.type === "ack" && f.msgId === second.msgId);
  await b.next((f) => f.type === "message" && f.item.seq === 2);

  // nothing is "read" until the other side says so
  b.send({ type: "read", upToSeq: 1 });
  const live = await a.next((f) => f.type === "receipt");
  assert.equal(live.readerId, idB);
  assert.equal(live.upToSeq, 1);
  assert.ok(live.ts > 0);

  // forward only: repeating or going back is ignored, past the newest message is ignored
  b.send({ type: "read", upToSeq: 1 });
  b.send({ type: "read", upToSeq: 99 });
  b.send({ type: "read", upToSeq: 2 });
  const later = await a.next((f) => f.type === "receipt" && f.upToSeq === 2);
  assert.equal(a.frames.filter((f) => f.type === "receipt").length, 2);
  assert.ok(later.ts >= live.ts);

  // a's reader view: no receipt for its own read of someone else's messages
  a.send({ type: "read", upToSeq: 2 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(b.frames.filter((f) => f.type === "receipt").length, 1);
  await a.close();

  // a reconnects later: its own messages come back with the time each was first read
  const a2 = await connect(srv.url);
  a2.send({ type: "join", roomId, senderId: idA });
  const page = await a2.next((f) => f.type === "messages" && f.dir === "initial");
  const byseq = Object.fromEntries(page.items.map((m) => [m.seq, m]));
  assert.equal(byseq[1].readAt, live.ts);
  assert.equal(byseq[2].readAt, later.ts);
  assert.ok(byseq[2].readAt >= byseq[1].readAt);

  // the reader's own view of those messages has no readAt (they are not its messages)
  const b2 = await connect(srv.url);
  b2.send({ type: "join", roomId, senderId: idB });
  const bpage = await b2.next((f) => f.type === "messages" && f.dir === "initial");
  assert.ok(bpage.items.every((m) => !("readAt" in m)));

  // bad input
  a2.send({ type: "read", upToSeq: "x" });
  await a2.next((f) => f.type === "error" && f.code === "bad_request");
  await a2.close();
  await b.close();
  await b2.close();
  await srv.stop();
}));
