import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

// Additive, versioned migrations. Never edit an existing entry; append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE rooms (
    room_hash  BLOB PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seq   INTEGER NOT NULL DEFAULT 0,
    bytes_used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE messages (
    room_hash BLOB    NOT NULL REFERENCES rooms(room_hash),
    seq       INTEGER NOT NULL,
    msg_id    TEXT    NOT NULL,
    sender_id TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    iv        TEXT    NOT NULL,
    ct        BLOB    NOT NULL,
    PRIMARY KEY (room_hash, seq),
    UNIQUE (room_hash, msg_id)
  ) WITHOUT ROWID;
  `,
];

// Fixed per-message bookkeeping added to the quota on top of iv + ciphertext.
const ROW_OVERHEAD_BYTES = 96;

export class QuotaError extends Error {
  constructor() {
    super("room quota reached");
    this.code = "quota";
  }
}

export function hashRoomId(roomIdBytes) {
  return createHash("sha256").update(roomIdBytes).digest();
}

function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
  let current = row?.v ?? 0;

  while (current < MIGRATIONS.length) {
    const next = current + 1;
    db.transaction(() => {
      db.exec(MIGRATIONS[current]);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(next);
    })();
    current = next;
  }
}

function toItem(row) {
  return {
    seq: row.seq,
    msgId: row.msg_id,
    senderId: row.sender_id,
    ts: row.ts,
    iv: row.iv,
    ct: row.ct.toString("base64"),
  };
}

export function openDatabase(path, { roomMaxBytes }) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // FULL: a message is only acknowledged to the sender once it is durable.
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);

  const q = {
    room: db.prepare("SELECT last_seq, bytes_used FROM rooms WHERE room_hash = ?"),
    createRoom: db.prepare(
      "INSERT INTO rooms (room_hash, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
    ),
    existing: db.prepare(
      "SELECT seq, ts FROM messages WHERE room_hash = ? AND msg_id = ?",
    ),
    bump: db.prepare(
      "UPDATE rooms SET last_seq = last_seq + 1, bytes_used = bytes_used + ? WHERE room_hash = ? RETURNING last_seq",
    ),
    insert: db.prepare(
      "INSERT INTO messages (room_hash, seq, msg_id, sender_id, ts, iv, ct) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    latest: db.prepare(
      "SELECT * FROM messages WHERE room_hash = ? ORDER BY seq DESC LIMIT ?",
    ),
    before: db.prepare(
      "SELECT * FROM messages WHERE room_hash = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
    ),
    after: db.prepare(
      "SELECT * FROM messages WHERE room_hash = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    ),
  };

  // The only place a room row is created: the first message sent to it.
  const appendTx = db.transaction((roomHash, { msgId, senderId, iv, ct }) => {
    const duplicate = q.existing.get(roomHash, msgId);
    if (duplicate) return { seq: duplicate.seq, ts: duplicate.ts, duplicate: true };

    const size = ct.length + iv.length + ROW_OVERHEAD_BYTES;
    const now = Date.now();
    q.createRoom.run(roomHash, now);

    const room = q.room.get(roomHash);
    if (room.bytes_used + size > roomMaxBytes) throw new QuotaError();

    const { last_seq: seq } = q.bump.get(size, roomHash);
    q.insert.run(roomHash, seq, msgId, senderId, now, iv, ct);
    return { seq, ts: now, duplicate: false };
  });

  return {
    roomExists: (roomHash) => !!q.room.get(roomHash),

    lastSeq: (roomHash) => q.room.get(roomHash)?.last_seq ?? 0,

    // ct is a base64 string; stored as raw bytes to save a third of the space.
    appendMessage(roomHash, { msgId, senderId, iv, ct }) {
      return appendTx(roomHash, { msgId, senderId, iv, ct: Buffer.from(ct, "base64") });
    },

    // Newest `limit` messages (optionally older than beforeSeq), returned oldest-first.
    listLatest(roomHash, { beforeSeq = null, limit }) {
      const rows =
        beforeSeq == null
          ? q.latest.all(roomHash, limit + 1)
          : q.before.all(roomHash, beforeSeq, limit + 1);
      const hasMore = rows.length > limit;
      return { items: rows.slice(0, limit).reverse().map(toItem), hasMore };
    },

    listAfter(roomHash, afterSeq, limit) {
      const rows = q.after.all(roomHash, afterSeq, limit + 1);
      return { items: rows.slice(0, limit).map(toItem), hasMore: rows.length > limit };
    },

    ping() {
      db.prepare("SELECT 1").get();
      return true;
    },

    close() {
      db.close();
    },
  };
}
