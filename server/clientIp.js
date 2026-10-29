// Behind Cloudflare every request arrives from the proxy, so the real visitor
// address is in CF-Connecting-IP. It is only trustworthy when the app is
// reachable exclusively through the tunnel (TRUST_PROXY=true, loopback bind).
export function getClientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers["cf-connecting-ip"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.trim();
    }
  }
  return req.socket.remoteAddress || "unknown";
}
