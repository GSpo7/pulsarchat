// Fixed-window counter keyed by an arbitrary string (usually a client IP).
export function createRateLimiter({ limit, windowMs }) {
  const buckets = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now > bucket.reset) buckets.delete(key);
    }
  }, Math.max(windowMs, 60_000));
  sweep.unref();

  return {
    // Returns true when the action is allowed.
    hit(key) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || now > bucket.reset) {
        bucket = { count: 0, reset: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count++;
      return bucket.count <= limit;
    },
    close() {
      clearInterval(sweep);
    },
  };
}
