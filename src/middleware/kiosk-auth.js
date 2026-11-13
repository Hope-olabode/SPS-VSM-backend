import { one } from "../db.js";
import { checkKioskCode, hashToken } from "../utils/kiosk-token.js";

// Failed attempts per IP, kept in memory (fine for one server). A real kiosk link never fails,
// so a burst of failures means someone is guessing.
const FAILS = new Map();
const MAX_FAILS = 30;
const WINDOW_MS = 60_000;

function tooMany(ip) {
  const entry = FAILS.get(ip);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILS);
}

function recordFail(ip) {
  const now = Date.now();
  if (FAILS.size > 5000) for (const [key, entry] of FAILS) if (entry.resetAt <= now) FAILS.delete(key);
  const entry = FAILS.get(ip);
  if (!entry || entry.resetAt <= now) FAILS.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count++;
}

/**
 * Step 1 of 2. The tablet sends its token in the x-kiosk-token header (it is never in a URL the API sees).
 * Adds req.kiosk = { locationId, locationName }. The unlock route uses this one on its own; every other kiosk route also needs step 2.
 */
export async function requireKioskToken(req, res, next) {
  if (tooMany(req.ip)) return res.status(429).json({ ok: false, error: "Too many attempts. Please wait a minute." });

  const token = req.get("x-kiosk-token");
  const row =
    typeof token === "string" && token.length <= 100
      ? await one(
          "SELECT k.location_id, l.name FROM kiosk_tokens k JOIN locations l ON l.id = k.location_id WHERE k.token_hash = ? AND k.revoked_at IS NULL AND l.active = 1",
          [hashToken(token)],
        )
      : null;

  if (!row) {
    recordFail(req.ip);
    return res.status(401).json({ ok: false, error: "This kiosk link isn't valid any more. Ask staff for the new one." });
  }
  req.kiosk = { locationId: row.location_id, locationName: row.name };
  next();
}

/**
 * Step 2 of 2. The tablet also sends the location's 6-digit access code in the x-kiosk-code header (an admin reads it
 * from the Locations page). Without it, or with a wrong one, the answer is 423 and the kiosk shows its code screen.
 */
export async function requireKioskCode(req, res, next) {
  const code = req.get("x-kiosk-code");
  if (!code) return res.status(423).json({ ok: false, error: "Enter the kiosk code to unlock this kiosk." });
  if (!(await checkKioskCode(req.kiosk.locationId, code))) {
    recordFail(req.ip);
    return res.status(423).json({ ok: false, error: "That kiosk code isn't right any more. Ask an admin for the current code." });
  }
  next();
}

/** Both steps, for the routes a visitor uses */
export const requireKiosk = [requireKioskToken, requireKioskCode];
