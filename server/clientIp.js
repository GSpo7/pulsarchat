export function getClientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers["cf-connecting-ip"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.trim();
    }
  }
  return req.socket.remoteAddress || "unknown";
}
