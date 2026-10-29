import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashRoomId, openDatabase, QuotaError } from "../server/db.js";

function setup(roomMaxBytes = 1024 * 1024) {
  const dir = mkdtempSync(join(tmpdir(), "pulsar-db-"));
  const path = join(dir, "test.db");
  const db = openDatabase(path, { roomMaxBytes });
  return { db, path, cleanup: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}

const room = () => hashRoomId(randomBytes(32));
const msg = (id, size = 40) => ({
  msgId: id,
  senderId: "sender-aaaa",
  iv: "AAAAAAAAAAAAAAAA",
  ct: randomBytes(size).toString("base64"),
});

test("room is created by the first message, seq is monotonic", () => {
  const { db, cleanup } = setup();
  const r = room();
  assert.equal(db.roomExists(r), false);
  assert.equal(db.lastSeq(r), 0);

  const a = db.appendMessage(r, msg("m1"));
  const b = db.appendMessage(r, msg("m2"));
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  assert.equal(db.roomExists(r), true);
  assert.equal(db.lastSeq(r), 2);
  cleanup();
});

test("sending the same msgId twice is idempotent", () => {
  const { db, cleanup } = setup();
  const r = room();
  const first = db.appendMessage(r, msg("dup"));
  const again = db.appendMessage(r, msg("dup"));
  assert.equal(again.duplicate, true);
  assert.equal(again.seq, first.seq);
  assert.equal(db.lastSeq(r), 1);
  cleanup();
});

test("same msgId in different rooms does not collide", () => {
  const { db, cleanup } = setup();
  const a = db.appendMessage(room(), msg("same"));
  const b = db.appendMessage(room(), msg("same"));
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 1);
  cleanup();
});

test("paging returns oldest-first pages and reports hasMore", () => {
  const { db, cleanup } = setup();
  const r = room();
  for (let i = 1; i <= 25; i++) db.appendMessage(r, msg(`m${i}`));

  const latest = db.listLatest(r, { limit: 10 });
  assert.deepEqual(latest.items.map((m) => m.seq), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  assert.equal(latest.hasMore, true);

  const older = db.listLatest(r, { beforeSeq: 16, limit: 10 });
  assert.deepEqual(older.items.map((m) => m.seq), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(older.hasMore, true);

  const oldest = db.listLatest(r, { beforeSeq: 6, limit: 10 });
  assert.equal(oldest.items.length, 5);
  assert.equal(oldest.hasMore, false);

  const after = db.listAfter(r, 22, 10);
  assert.deepEqual(after.items.map((m) => m.seq), [23, 24, 25]);
  assert.equal(after.hasMore, false);
  cleanup();
});

test("ciphertext round-trips byte-for-byte and rooms are isolated", () => {
  const { db, cleanup } = setup();
  const r1 = room();
  const r2 = room();
  const m = msg("x", 300);
  db.appendMessage(r1, m);
  const [item] = db.listLatest(r1, { limit: 5 }).items;
  assert.equal(item.ct, m.ct);
  assert.equal(item.iv, m.iv);
  assert.equal(db.listLatest(r2, { limit: 5 }).items.length, 0);
  cleanup();
});

test("quota rejects instead of evicting, and keeps old messages", () => {
  const { db, cleanup } = setup(1000);
  const r = room();
  db.appendMessage(r, msg("m1", 300));
  db.appendMessage(r, msg("m2", 300));
  assert.throws(() => db.appendMessage(r, msg("m3", 300)), QuotaError);
  assert.equal(db.listLatest(r, { limit: 10 }).items.length, 2);
  assert.equal(db.lastSeq(r), 2);
  cleanup();
});

test("data survives closing and reopening the database", () => {
  const { db, path, cleanup } = setup();
  const r = room();
  db.appendMessage(r, msg("keep"));
  db.close();
  const reopened = openDatabase(path, { roomMaxBytes: 1024 * 1024 });
  assert.equal(reopened.lastSeq(r), 1);
  assert.equal(reopened.listLatest(r, { limit: 5 }).items[0].msgId, "keep");
  reopened.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
  void cleanup;
});

test("database stores the hash, never the raw room id", () => {
  const { db, path, cleanup } = setup();
  const raw = randomBytes(32);
  db.appendMessage(hashRoomId(raw), msg("m"));
  db.close();
  assert.equal(readFileSync(path).includes(raw), false);
  rmSync(join(path, ".."), { recursive: true, force: true });
  void cleanup;
});

