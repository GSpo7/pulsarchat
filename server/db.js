import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

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
  `
  CREATE TABLE read_receipts (
    room_hash BLOB    NOT NULL REFERENCES rooms(room_hash),
    reader_id TEXT    NOT NULL,
    up_to_seq INTEGER NOT NULL,
    ts        INTEGER NOT NULL,
    PRIMARY KEY (room_hash, reader_id, up_to_seq)
  ) WITHOUT ROWID;
  CREATE INDEX read_receipts_by_seq ON read_receipts (room_hash, up_to_seq);
  `,
];

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

export function openDatabase(path, { roomMaxBytes, pageMaxBytes = 8 * 1024 * 1024 }) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
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
    latestSizes: db.prepare(
      "SELECT seq, length(ct) AS size FROM messages WHERE room_hash = ? ORDER BY seq DESC LIMIT ?",
    ),
    beforeSizes: db.prepare(
      "SELECT seq, length(ct) AS size FROM messages WHERE room_hash = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
    ),
    afterSizes: db.prepare(
      "SELECT seq, length(ct) AS size FROM messages WHERE room_hash = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    ),
    range: db.prepare(
      "SELECT * FROM messages WHERE room_hash = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC",
    ),
    lastRead: db.prepare(
      "SELECT MAX(up_to_seq) AS seq FROM read_receipts WHERE room_hash = ? AND reader_id = ?",
    ),
    addRead: db.prepare(
      "INSERT OR IGNORE INTO read_receipts (room_hash, reader_id, up_to_seq, ts) VALUES (?, ?, ?, ?)",
    ),
    firstRead: db.prepare(
      "SELECT MIN(ts) AS ts FROM read_receipts WHERE room_hash = ? AND up_to_seq >= ? AND reader_id != ?",
    ),
    bytesAfter: db.prepare(
      "SELECT COALESCE(SUM(length(ct)), 0) AS bytes FROM messages WHERE room_hash = ? AND seq > ?",
    ),
  };
  function takeWithinBudget(sizes, limit) {
    let used = 0;
    let count = 0;
    while (count < sizes.length && count < limit) {
      if (count > 0 && used + sizes[count].size > pageMaxBytes) break;
      used += sizes[count].size;
      count++;
    }
    return { taken: sizes.slice(0, count), hasMore: sizes.length > count };
  }

  function loadRange(roomHash, taken) {
    if (taken.length === 0) return [];
    const seqs = taken.map((row) => row.seq);
    return q.range.all(roomHash, Math.min(...seqs), Math.max(...seqs)).map(toItem);
  }

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

    appendMessage(roomHash, { msgId, senderId, iv, ct }) {
      return appendTx(roomHash, { msgId, senderId, iv, ct: Buffer.from(ct, "base64") });
    },

    listLatest(roomHash, { beforeSeq = null, limit }) {
      const sizes =
        beforeSeq == null
          ? q.latestSizes.all(roomHash, limit + 1)
          : q.beforeSizes.all(roomHash, beforeSeq, limit + 1);
      const { taken, hasMore } = takeWithinBudget(sizes, limit);
      return { items: loadRange(roomHash, taken), hasMore };
    },

    listAfter(roomHash, afterSeq, limit) {
      const { taken, hasMore } = takeWithinBudget(
        q.afterSizes.all(roomHash, afterSeq, limit + 1),
        limit,
      );
      return { items: loadRange(roomHash, taken), hasMore };
    },

    recordRead(roomHash, readerId, upToSeq) {
      const room = q.room.get(roomHash);
      if (!room || upToSeq > room.last_seq) return null;
      if (upToSeq <= (q.lastRead.get(roomHash, readerId).seq ?? 0)) return null;
      const ts = Date.now();
      q.addRead.run(roomHash, readerId, upToSeq, ts);
      return ts;
    },

    readAt: (roomHash, seq, senderId) => q.firstRead.get(roomHash, seq, senderId).ts ?? null,

    bytesAfter: (roomHash, afterSeq) => q.bytesAfter.get(roomHash, afterSeq).bytes,

    ping() {
      db.prepare("SELECT 1").get();
      return true;
    },

    close() {
      db.close();
    },
  };
}
