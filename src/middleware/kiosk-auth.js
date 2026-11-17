import { one } from "../db.js";
import { checkKioskUnlockProof, hashToken, makeKioskUnlockProof } from "../utils/kiosk-token.js";

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
  req.kiosk = { locationId: row.location_id, locationName: row.name, tokenHash: hashToken(token) };
  next();
}

// The tablet keeps an httpOnly cookie (one per kiosk link) that proves the code was entered; it never holds the code itself.
const UNLOCK_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // about 6 months; regenerating the code or the link ends it sooner
const unlockCookie = (kiosk) => `kiosk_${kiosk.tokenHash.slice(0, 16)}`;
const unlockCookieOptions = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" };

/** Called right after the right code was entered: hands the tablet its proof */
export async function setKioskUnlocked(res, kiosk) {
  const proof = await makeKioskUnlockProof(kiosk.locationId, kiosk.tokenHash);
  if (proof) res.cookie(unlockCookie(kiosk), proof, { ...unlockCookieOptions, maxAge: UNLOCK_MAX_AGE_MS });
}

/**
 * Step 2 of 2. The tablet must have been unlocked with the location's 6-digit access code (POST /api/kiosk/unlock), which
 * gave it an httpOnly cookie as proof. Without that cookie, or after the code or the link was regenerated, the answer is 423
 * and the kiosk shows its code screen. The code itself is only ever sent once, to /unlock, and is never kept on the tablet.
 */
export async function requireKioskCode(req, res, next) {
  const proof = req.cookies?.[unlockCookie(req.kiosk)];
  if (!proof) return res.status(423).json({ ok: false, error: "Enter the kiosk code to unlock this kiosk." });
  // a proof can't be guessed (it is a 256-bit HMAC), so a stale one after a regenerate isn't counted as an attack
  if (!(await checkKioskUnlockProof(req.kiosk.locationId, req.kiosk.tokenHash, proof))) {
    return res.status(423).json({ ok: false, error: "That kiosk code isn't right any more. Ask an admin for the current code." });
  }
  next();
}

/** Both steps, for the routes a visitor uses */
export const requireKiosk = [requireKioskToken, requireKioskCode];
