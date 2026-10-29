#!/usr/bin/env node
// Operator tool: list permanent rooms or permanently delete one.
// This is the ONLY code path that deletes room data (app code never does).
//
//   node scripts/purge-room.js --list
//   node scripts/purge-room.js --code "the room code"      (asks for confirmation)
//   node scripts/purge-room.js --hash <64-hex room hash>   (from --list)
//   add --yes to skip the confirmation prompt
//
// Reads DATABASE_PATH like the server. Run it as the service user, e.g.
//   sudo -u pulsarchat env $(sudo cat /etc/pulsarchat.env | xargs) node scripts/purge-room.js --list
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

const describe = (row) =>
  `${row.room_hash.toString("hex")}  messages=${row.last_seq}  bytes=${row.bytes_used}  created=${new Date(row.created_at).toISOString()}`;

if (flag("--list")) {
  const rows = db.prepare("SELECT * FROM rooms ORDER BY created_at").all();
  for (const row of rows) console.log(describe(row));
  console.log(`${rows.length} room(s)`);
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
  db.prepare("DELETE FROM messages WHERE room_hash = ?").run(roomHash);
  db.prepare("DELETE FROM rooms WHERE room_hash = ?").run(roomHash);
})();
console.log("deleted");
