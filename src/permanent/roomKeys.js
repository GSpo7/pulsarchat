/**
 * Permanent room keys.
 *
 * A room code (any text, 1..MAX_CODE_LENGTH chars) is stretched with PBKDF2
 * into 64 bytes:
 *   bytes  0..31  roomId   — sent to the server, identifies the room
 *   bytes 32..63  AES key  — never leaves the browser
 *
 * The code itself is never sent anywhere. The parameters below are part of
 * the stored data format: changing any of them makes existing rooms
 * unreachable. A new scheme needs a new versioned salt ("v2"), not an edit.
 */

export const MAX_CODE_LENGTH = 2048;

const SALT = "pulsarchat/permanent/v1";
const ITERATIONS = 600000;

// No 0/O/1/I so codes read aloud or copied by hand survive; 32 symbols = 5 bits each.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// NFKC makes the same visible text hash identically across keyboards/devices;
// trimming avoids a stray pasted space silently opening a different room.
export function normalizeCode(code) {
  return String(code ?? "").normalize("NFKC").trim();
}

export function validateCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, reason: "enter a code" };
  if (normalized.length > MAX_CODE_LENGTH) {
    return { ok: false, reason: `code is too long (max ${MAX_CODE_LENGTH} characters)` };
  }
  return { ok: true, code: normalized };
}

export async function deriveRoomKeys(code) {
  if (!crypto?.subtle) {
    throw new Error("Permanent rooms need HTTPS (or localhost) for encryption");
  }
  const checked = validateCode(code);
  if (!checked.ok) throw new Error(checked.reason);

  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(checked.code),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(SALT), iterations: ITERATIONS },
    baseKey,
    512,
  );
  const bytes = new Uint8Array(bits);

  const key = await crypto.subtle.importKey(
    "raw",
    bytes.slice(32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  return { roomId: toBase64Url(bytes.slice(0, 32)), key };
}

// Uniform random code, 5 bits per symbol (rejection-free: 256 is a multiple of 32).
export function generateCode(groups = 4, groupLength = 5) {
  const values = crypto.getRandomValues(new Uint8Array(groups * groupLength));
  const symbols = Array.from(values, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]);
  const parts = [];
  for (let i = 0; i < groups; i++) {
    parts.push(symbols.slice(i * groupLength, (i + 1) * groupLength).join(""));
  }
  return parts.join("-");
}

// Rough guess-resistance hint for the UI. Not a guarantee.
export function estimateStrength(code) {
  const text = normalizeCode(code);
  if (!text) return { level: "empty", bits: 0 };

  let pool = 0;
  if (/[a-z]/.test(text)) pool += 26;
  if (/[A-Z]/.test(text)) pool += 26;
  if (/\d/.test(text)) pool += 10;
  if (/[^A-Za-z0-9]/.test(text)) pool += 33;

  // Repeated characters add little: cap the effective length.
  const effectiveLength = Math.min(text.length, new Set(text).size * 2);
  const bits = Math.round(effectiveLength * Math.log2(Math.max(pool, 2)));

  if (bits < 40) return { level: "weak", bits };
  if (bits < 64) return { level: "fair", bits };
  return { level: "strong", bits };
}

export function buildInviteUrl(code) {
  const base = (import.meta.env.VITE_APP_URL || window.location.origin).replace(/\/+$/, "");
  return `${base}/#/r/${encodeURIComponent(normalizeCode(code))}`;
}

// Reads a #/r/<code> invite from the address bar and removes it immediately.
export function consumeInviteFromUrl() {
  const match = window.location.hash.match(/^#\/r\/(.+)$/);
  if (!match) return null;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
