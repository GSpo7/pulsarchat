// All server settings come from the environment (see .env.example).

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function list(name) {
  return (process.env[name] || "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function loadConfig() {
  const isProduction = process.env.NODE_ENV === "production";
  const maxImageBytes = int("MAX_IMAGE_BYTES", 1024 * 1024);

  return {
    isProduction,
    port: int("PORT", 9000),
    // Behind Cloudflare Tunnel the app must only listen on loopback.
    host: process.env.HOST || (isProduction ? "127.0.0.1" : undefined),
    trustProxy: process.env.TRUST_PROXY === "true",
    allowedOrigins: list("ALLOWED_ORIGINS"),
    databasePath: process.env.DATABASE_PATH || "./data/pulsar.db",
    limits: {
      roomMaxBytes: int("ROOM_MAX_BYTES", 500 * 1024 * 1024),
      maxTextBytes: int("MAX_TEXT_BYTES", 64 * 1024),
      maxImageBytes,
      minFreeDiskBytes: int("MIN_FREE_DISK_BYTES", 2 * 1024 * 1024 * 1024),
      // base64 of the largest ciphertext plus JSON framing
      maxFrameBytes: Math.ceil((maxImageBytes * 4) / 3) + 4096,
      socketMessagesPer10s: int("SOCKET_MESSAGES_PER_10S", 20),
      connectionsPerMinutePerIp: int("CONNECTIONS_PER_MINUTE_PER_IP", 30),
      newRoomsPerHourPerIp: int("NEW_ROOMS_PER_HOUR_PER_IP", 20),
      idleTimeoutMs: int("IDLE_TIMEOUT_MS", 90_000),
    },
  };
}
