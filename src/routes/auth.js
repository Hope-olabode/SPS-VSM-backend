import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { one, query } from "../db.js";
import { clearSession, requireAuth, requireRole, setActiveLocation, setSession } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";

const router = Router();

const LocationBody = z.object({ locationId: z.string().trim().min(1).max(64) });
const LoginBody = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

router.post("/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "Enter your email and password." });

  const user = await one("SELECT * FROM users WHERE email = ?", [parsed.data.email]);
  // same message whether the email or the password is wrong, so emails can't be guessed
  const valid = user && (await bcrypt.compare(parsed.data.password, user.password_hash));
  if (!valid) return res.status(401).json({ ok: false, error: "Incorrect email or password." });

  await query("UPDATE users SET last_active_at = NOW() WHERE id = ?", [user.id]);
  setSession(res, user);
  setActiveLocation(res, null); // every sign-in starts at the user's own location
  await audit("USER_LOGIN", "Security", { id: user.id, name: user.name, role: user.role, locationId: user.location_id });
  res.json({ ok: true, user: { name: user.name, email: user.email, role: user.role } });
});

router.post("/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

const ME_SQL = "SELECT u.id, u.name, u.email, u.role, l.id AS locationId, l.name AS locationName FROM users u JOIN locations l ON l.id = u.location_id WHERE u.id = ?";

/**
 * The signed-in user as the app shows them. locationId and locationName are the location they are working in right now
 * (a global admin may have picked another one); homeLocationId is the one they belong to.
 */
async function loadMe(req) {
  const user = await one(ME_SQL, [req.user.id]);
  if (!user) return null;
  const me = { ...user, homeLocationId: user.locationId };
  if (req.user.locationId === user.locationId) return me;
  const active = await one("SELECT id, name FROM locations WHERE id = ?", [req.user.locationId]);
  return active ? { ...me, locationId: active.id, locationName: active.name } : me;
}

router.get("/me", requireAuth, async (req, res) => {
  const user = await loadMe(req);
  if (!user) return res.status(401).json({ ok: false, error: "Not signed in." });
  res.json({ ok: true, user });
});

/** POST /api/auth/location  { locationId } — a global admin picks which location the dashboard shows. The choice lasts until sign-out. */
router.post("/location", requireAuth, requireRole("GLOBAL_ADMIN"), async (req, res) => {
  const parsed = LocationBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "Choose a location." });

  const location = await one("SELECT id, active FROM locations WHERE id = ?", [parsed.data.locationId]);
  if (!location) return res.status(404).json({ ok: false, error: "Location not found." });
  if (!location.active) return res.status(409).json({ ok: false, error: "This location is inactive. Make it active on the Locations page first." });

  const home = req.user.homeLocationId ?? req.user.locationId;
  setActiveLocation(res, location.id === home ? null : location.id);
  res.json({ ok: true, locationId: location.id });
});

/** Sends 400 with the first message, plus every message by field so the form can show each under its own box */
const invalid = (res, error, issues) => res.status(400).json({ ok: false, error, issues });

const ProfileBody = z.object({
  name: z.string().trim().min(1, "Enter your name").max(160),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(190),
});

/** PATCH /api/auth/me — change your own name and email */
router.patch("/me", requireAuth, async (req, res) => {
  const parsed = ProfileBody.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    return invalid(res, Object.values(issues).flat()[0] ?? "Some details are missing or invalid.", issues);
  }
  const { name, email } = parsed.data;

  const before = await one("SELECT name, email FROM users WHERE id = ?", [req.user.id]);
  if (!before) return res.status(401).json({ ok: false, error: "Not signed in." });

  try {
    await query("UPDATE users SET name = ?, email = ? WHERE id = ?", [name, email, req.user.id]);
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      const message = "Another user already has this email.";
      return res.status(409).json({ ok: false, error: message, issues: { email: [message] } });
    }
    throw err;
  }

  // the session cookie carries the name, which the audit trail uses, so refresh it
  setSession(res, await one("SELECT * FROM users WHERE id = ?", [req.user.id]));
  if (name !== before.name || email !== before.email) await audit("PROFILE_UPDATED", "Security", { ...req.user, name });

  res.json({ ok: true, user: await loadMe(req) });
});

const PasswordBody = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z
    .string()
    .max(72) // bcrypt only reads the first 72 characters
    .refine((value) => value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value), "Use at least 8 characters, with 1 letter and 1 number"),
});

/** POST /api/auth/change-password — checks the current password first */
router.post("/change-password", requireAuth, async (req, res) => {
  const parsed = PasswordBody.safeParse(req.body);
  if (!parsed.success) {
    const fields = parsed.error.flatten().fieldErrors;
    return invalid(res, Object.values(fields).flat()[0] ?? "Some details are missing or invalid.", { current: fields.currentPassword, next: fields.newPassword });
  }
  const { currentPassword, newPassword } = parsed.data;

  const user = await one("SELECT id, password_hash FROM users WHERE id = ?", [req.user.id]);
  if (!user) return res.status(401).json({ ok: false, error: "Not signed in." });

  // 400, not 401: a wrong password here must not send the person to the login page
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    return invalid(res, "Your current password is incorrect.", { current: ["Your current password is incorrect."] });
  }
  if (newPassword === currentPassword) {
    return invalid(res, "Choose a password you haven't used here", { next: ["Choose a password you haven't used here"] });
  }

  await query("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(newPassword, 12), user.id]);
  await audit("PASSWORD_CHANGED", "Security", req.user);
  res.json({ ok: true });
});

export default router;
