/**
 * A small in-memory limiter for the few routes anyone on the internet can call (no login).
 * Counts requests per IP in a fixed window and answers 429 once the limit is passed.
 * It lives in this one process, so with several servers each keeps its own count; that is fine as a brake on abuse.
 * Behind a proxy, set TRUST_PROXY (see app.js) so req.ip is the visitor's address and not the proxy's.
 */
export function rateLimit({ windowMs, max, message = "Too many attempts. Please try again in a few minutes." }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: message });
    }
    next();
  };
}
