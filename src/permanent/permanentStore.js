/**
 * Rooms joined on this device (IndexedDB, in-memory fallback).
 *
 * Record: { roomId, code | null, label, senderId, displayName, remember, lastOpened }
 * `code` is only kept when the user ticks "remember on this device".
 * Message history is NOT stored here; the server is the source of truth.
 */

const DB_NAME = "pulsarchat_permanent";
const STORE = "rooms";

let idbFailed = false;
const memRooms = new Map();

function idbAvailable() {
  return !idbFailed && typeof window !== "undefined" && !!window.indexedDB;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      event.target.result.createObjectStore(STORE, { keyPath: "roomId" });
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

async function run(mode, action) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function withFallback(idbAction, memAction) {
  if (!idbAvailable()) return memAction();
  try {
    return await idbAction();
  } catch (error) {
    console.warn("[pulsarchat] Permanent-room storage unavailable, using memory:", error);
    idbFailed = true;
    return memAction();
  }
}

function randomId(bytes) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function createSenderId() {
  return `dev-${randomId(8)}`;
}

export function getRoom(roomId) {
  return withFallback(
    async () => (await run("readonly", (store) => store.get(roomId))) || null,
    () => memRooms.get(roomId) || null,
  );
}

export async function listRememberedRooms() {
  const rooms = await withFallback(
    () => run("readonly", (store) => store.getAll()),
    () => [...memRooms.values()],
  );
  return (rooms || [])
    .filter((room) => room.remember && room.code)
    .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
}

export function saveRoom(record) {
  const next = { ...record, lastOpened: Date.now() };
  return withFallback(
    async () => {
      await run("readwrite", (store) => store.put(next));
      return next;
    },
    () => {
      memRooms.set(next.roomId, next);
      return next;
    },
  );
}

// Local only: the room and its server-side history are untouched.
export function forgetRoom(roomId) {
  return withFallback(
    () => run("readwrite", (store) => store.delete(roomId)),
    () => memRooms.delete(roomId),
  );
}
