/**
 * AES-GCM sealing for permanent-room messages.
 *
 * utils/crypto.js encrypt() spreads the whole ciphertext into
 * String.fromCharCode(...), which overflows the call stack for payloads of a
 * few hundred KB (images). These helpers encode in slices instead.
 */

const SLICE = 0x8000;

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sealJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ciphertext)) };
}

// Throws if the key is wrong or the data was altered (GCM authentication).
export async function openJson(key, { iv, ct }) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ct),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
