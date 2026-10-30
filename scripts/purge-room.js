#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import Database from "better-sqlite3";
import { hashRoomId } from "../server/db.js";
import { deriveRoomKeys } from "../src/permanent/roomKeys.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const databasePath = process.env.DATABASE_PATH || "./data/pulsar.db";
const db = new Database(databasePath, { fileMustExist: true });
db.pragma("busy_timeout = 5000");

const lastActivity = db.prepare("SELECT MAX(ts) AS ts FROM messages WHERE room_hash = ?");
const iso = (ms) => (ms ? new Date(ms).toISOString() : "-");

const describe = (row) =>
  `${row.room_hash.toString("hex")}  messages=${row.last_seq}  bytes=${row.bytes_used}  created=${iso(row.created_at)}  last_message=${iso(lastActivity.get(row.room_hash).ts)}`;

if (flag("--list")) {
  const rows = db.prepare("SELECT * FROM rooms ORDER BY created_at DESC").all();
  for (const row of rows) console.log(describe(row));
  console.log(`${rows.length} room(s), newest first`);
  process.exit(0);
}

let roomHash;
if (value("--code")) {
  const { roomId } = await deriveRoomKeys(value("--code"));
  roomHash = hashRoomId(Buffer.from(roomId, "base64url"));
} else if (value("--hash")) {
  roomHash = Buffer.from(value("--hash"), "hex");
}

if (!roomHash || roomHash.length !== 32) {
  console.error("usage: purge-room.js --list | --code <code> | --hash <hex> [--yes]");
  process.exit(2);
}

const room = db.prepare("SELECT * FROM rooms WHERE room_hash = ?").get(roomHash);
if (!room) {
  console.error("no such room");
  process.exit(1);
}

console.log(describe(room));
if (!flag("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Type DELETE to permanently remove this room and all its messages: ");
  rl.close();
  if (answer !== "DELETE") {
    console.log("aborted");
    process.exit(1);
  }
}

db.transaction(() => {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'read_receipts'").get()) {
    db.prepare("DELETE FROM read_receipts WHERE room_hash = ?").run(roomHash);
  }
  db.prepare("DELETE FROM messages WHERE room_hash = ?").run(roomHash);
  db.prepare("DELETE FROM rooms WHERE room_hash = ?").run(roomHash);
})();
console.log("deleted");
console.log("Note: copies in existing backups are not touched; they age out with the backup retention (30 days in DEPLOYMENT.md).");
