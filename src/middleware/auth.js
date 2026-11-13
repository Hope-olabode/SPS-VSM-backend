import jwt from "jsonwebtoken";
import { one } from "../db.js";

const COOKIE = "vms_session";
// The location a global admin is looking at. Everyone else always works in their own location.
const LOCATION_COOKIE = "vms_location";
const MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

export function setSession(res, user) {
  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, locationId: user.location_id },
    process.env.JWT_SECRET,
    { expiresIn: "8h" },
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_MS,
  });
}

const locationCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
};

/** Remember (or, with null, forget) which location a global admin is working in */
export function setActiveLocation(res, locationId) {
  if (locationId) res.cookie(LOCATION_COOKIE, locationId, { ...locationCookieOptions, maxAge: MAX_AGE_MS });
  else res.clearCookie(LOCATION_COOKIE, locationCookieOptions);
}

export const clearSession = (res) => {
  res.clearCookie(COOKIE);
  res.clearCookie(LOCATION_COOKIE, locationCookieOptions);
};

/**
 * Put this before any route that needs a signed-in user. Adds req.user.
 * Every route filters by req.user.locationId, so a global admin who picked another location in the top bar
 * simply gets that location here (the home one stays in req.user.homeLocationId). Nobody else can switch.
 */
export async function requireAuth(req, res, next) {
  try {
    req.user = jwt.verify(req.cookies[COOKIE], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ ok: false, error: "Not signed in." });
  }

  const picked = req.cookies[LOCATION_COOKIE];
  if (picked && req.user.role === "GLOBAL_ADMIN" && picked !== req.user.locationId) {
    const location = await one("SELECT id FROM locations WHERE id = ?", [picked]);
    if (location) req.user = { ...req.user, homeLocationId: req.user.locationId, locationId: location.id };
    else res.clearCookie(LOCATION_COOKIE, locationCookieOptions); // it was deleted, so fall back to the home location
  }
  next();
}

/** requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN") — use after requireAuth */
export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ ok: false, error: "Not allowed." });
