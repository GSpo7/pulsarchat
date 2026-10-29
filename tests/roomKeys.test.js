import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  MAX_CODE_LENGTH,
  deriveRoomKeys,
  estimateStrength,
  generateCode,
  normalizeCode,
  validateCode,
} from "../src/permanent/roomKeys.js";
import { openJson, sealJson } from "../src/permanent/messageCrypto.js";
import { openDatabase } from "../server/db.js";
import { createPermanentRooms } from "../server/permanentRooms.js";

test("same code gives the same room id; different codes differ", async () => {
  const a1 = await deriveRoomKeys("my secret code");
  const a2 = await deriveRoomKeys("my secret code");
  const b = await deriveRoomKeys("my secret code!");
  assert.equal(a1.roomId, a2.roomId);
  assert.notEqual(a1.roomId, b.roomId);
  assert.match(a1.roomId, /^[A-Za-z0-9_-]{43}$/);
});

test("any kind of code works: digits, unicode, one character, 2048 characters", async () => {
  const ids = new Set();
  for (const code of ["1", "123456", "héllo wörld", "密码🔐", "x".repeat(MAX_CODE_LENGTH)]) {
    ids.add((await deriveRoomKeys(code)).roomId);
  }
  assert.equal(ids.size, 5);
});

test("2049 characters and empty codes are rejected with a message", async () => {
  assert.equal(validateCode("x".repeat(MAX_CODE_LENGTH + 1)).ok, false);
  assert.equal(validateCode("   ").ok, false);
  await assert.rejects(deriveRoomKeys("x".repeat(MAX_CODE_LENGTH + 1)), /too long/);
});

test("normalisation: surrounding spaces and unicode composition do not change the room", async () => {
  const composed = "café";
  const decomposed = "café";
  assert.equal(normalizeCode(`  ${composed}  `), composed);
  assert.equal((await deriveRoomKeys(composed)).roomId, (await deriveRoomKeys(`  ${decomposed} `)).roomId);
  // case matters
  assert.notEqual((await deriveRoomKeys("Secret")).roomId, (await deriveRoomKeys("secret")).roomId);
});

test("derivation is frozen: matches an independent PBKDF2 implementation", async () => {
  // Computed with node:crypto pbkdf2Sync(code, "pulsarchat/permanent/v1", 600000, 64, "sha256").
  // If this fails, existing rooms would become unreachable. Do not "fix" the vector.
  const { roomId } = await deriveRoomKeys("pulsarchat test vector");
  assert.equal(roomId, "93cAtv-kYhONq7FlcfKGP0_CkGACvEO7oiDhEFBL6js");
});

test("AES key is non-extractable and the wrong key cannot decrypt", async () => {
  const right = await deriveRoomKeys("right code");
  const wrong = await deriveRoomKeys("wrong code");
  assert.equal(right.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", right.key));

  const sealed = await sealJson(right.key, { v: 1, text: "secret" });
  assert.deepEqual(await openJson(right.key, sealed), { v: 1, text: "secret" });
  await assert.rejects(openJson(wrong.key, sealed));

  // tampering is detected (GCM authentication)
  const bytes = Buffer.from(sealed.ct, "base64");
  bytes[0] ^= 1;
  await assert.rejects(openJson(right.key, { iv: sealed.iv, ct: bytes.toString("base64") }));
});

test("large payloads (image-sized) seal and open without overflowing the stack", async () => {
  const { key } = await deriveRoomKeys("big payload");
  const image = `data:image/jpeg;base64,${"A".repeat(900_000)}`;
  const sealed = await sealJson(key, { v: 1, image });
  assert.match(sealed.iv, /^[A-Za-z0-9+/]{16}$/); // what the server expects
  const opened = await openJson(key, sealed);
  assert.equal(opened.image.length, image.length);
});

test("generated codes are well formed, unique, and rated strong", () => {
  const codes = new Set(Array.from({ length: 200 }, () => generateCode()));
  assert.equal(codes.size, 200);
  for (const code of codes) assert.match(code, /^([A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(estimateStrength(generateCode()).level, "strong");
});

test("weak codes are flagged", () => {
  assert.equal(estimateStrength("1234").level, "weak");
  assert.equal(estimateStrength("aaaaaaaaaaaaaaaaaaaa").level, "weak");
  assert.equal(estimateStrength("").level, "empty");
  assert.notEqual(estimateStrength("correct horse battery staple 77!").level, "weak");
});

// ── end to end: two people, one code, the real server ────────────────────────
test("two users with the same code exchange an encrypted message via the server; server holds only ciphertext", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pulsar-e2e-"));
  const dbPath = join(dir, "e2e.db");
  const config = {
    isProduction: false,
    trustProxy: false,
    allowedOrigins: [],
    databasePath: dbPath,
    limits: {
      roomMaxBytes: 1024 * 1024,
      maxTextBytes: 65536,
      maxImageBytes: 1024 * 1024,
      minFreeDiskBytes: 0,
      maxFrameBytes: 1500000,
      socketMessagesPer10s: 20,
      connectionsPerMinutePerIp: 100,
      newRoomsPerHourPerIp: 100,
      idleTimeoutMs: 90000,
    },
  };
  const quiet = { log() {}, warn() {}, error() {} };
  const db = openDatabase(dbPath, { roomMaxBytes: config.limits.roomMaxBytes });
  const rooms = createPermanentRooms({ db, config, logger: quiet, freeDiskBytes: () => Infinity });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/permanent`;

  try {
    const code = "our permanent room ✨ 2026";
    const alice = await deriveRoomKeys(code);
    const bob = await deriveRoomKeys(code);
    assert.equal(alice.roomId, bob.roomId);

    const open = async (roomId, senderId) => {
      const ws = new WebSocket(url);
      const frames = [];
      ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
      await new Promise((resolve) => ws.once("open", resolve));
      ws.send(JSON.stringify({ type: "join", roomId, senderId }));
      return { ws, frames };
    };
    const until = async (frames, pred) => {
      for (let i = 0; i < 100; i++) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("timeout");
    };

    // Alice writes while Bob is away
    const a = await open(alice.roomId, "alice-device-01");
    await until(a.frames, (f) => f.type === "joined");
    const sealed = await sealJson(alice.key, { v: 1, text: "see you later, wörld", name: "Alice" });
    a.ws.send(JSON.stringify({ type: "send", kind: "text", msgId: "m_e2e_1", ...sealed }));
    await until(a.frames, (f) => f.type === "ack");
    a.ws.close();

    // Bob arrives later with just the code
    const b = await open(bob.roomId, "bob-device-0001");
    const page = await until(b.frames, (f) => f.type === "messages");
    assert.equal(page.items.length, 1);
    const plain = await openJson(bob.key, page.items[0]);
    assert.equal(plain.text, "see you later, wörld");
    assert.equal(plain.name, "Alice");
    b.ws.close();

    // A stranger with a different code sees nothing
    const eve = await deriveRoomKeys("a different code");
    const e = await open(eve.roomId, "eve-device-0001");
    const empty = await until(e.frames, (f) => f.type === "messages");
    assert.equal(empty.items.length, 0);
    e.ws.close();
  } finally {
    rooms.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
