// WebSocket origin allowlist. Exact string match, never prefix/substring.
// Requests without an Origin header (scripts, curl, tests) are allowed: the
// check exists to stop other websites from opening sockets from a visitor's
// browser, which only browsers can do.

const NATIVE_ORIGINS = ["capacitor://localhost", "https://localhost", "http://localhost"];
// Dev only: localhost and private-LAN addresses (testing from a phone on the same Wi-Fi).
const LOCAL_DEV =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

export function isOriginAllowed(origin, { allowedOrigins, isProduction }) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (NATIVE_ORIGINS.includes(origin)) return true;
  if (!isProduction && LOCAL_DEV.test(origin)) return true;
  return false;
}
