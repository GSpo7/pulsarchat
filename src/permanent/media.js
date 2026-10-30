/**
 * Media helpers for permanent rooms.
 *
 * Photos go out exactly as the file is (no resize, no re-encode). The ceiling
 * keeps the encrypted payload (file × ~1.34 as a data URL) under the server's
 * MAX_IMAGE_BYTES default of 32 MB.
 */

export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 300;

export function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("could not read file"));
    reader.readAsDataURL(blob);
  });
}

// Decrypted payloads come from other people holding the code: only render real media URLs.
export const isImageDataUrl = (value) => typeof value === "string" && value.startsWith("data:image/");
export const isAudioDataUrl = (value) => typeof value === "string" && value.startsWith("data:audio/");

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
