import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";
import { temporaryPassword } from "../utils/password.js";

const router = Router();
router.use(requireAuth, requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN"));

const ROLES = ["GLOBAL_ADMIN", "LOCATION_ADMIN", "MANAGER", "TENANT_REP", "USER"];
const isGlobal = (user) => user.role === "GLOBAL_ADMIN";
const fail = (res, status, error) => res.status(status).json({ ok: false, error });

const SELECT =
  "SELECT u.id, u.name, u.email, u.role, u.location_id, u.last_active_at, u.created_at, l.name AS branch FROM users u JOIN locations l ON l.id = u.location_id";

const toApi = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  branch: row.branch,
  locationId: row.location_id,
  createdAt: row.created_at,
  lastActiveAt: row.last_active_at,
});

const Name = z.string().trim().min(1, "Enter the user's name").max(160);
const Email = z.string().trim().toLowerCase().email("Enter a valid email address").max(190);
const Create = z.object({ name: Name, email: Email, role: z.enum(ROLES).default("USER"), branch: z.string().trim().min(1, "Choose a location") });
const Update = z.object({ name: Name.optional(), email: Email.optional(), role: z.enum(ROLES).optional(), branch: z.string().trim().min(1).optional() });

const firstProblem = (error) => Object.values(error.flatten().fieldErrors).flat()[0] ?? "Some details are missing or invalid.";

/** The user in the URL, but only if the signed-in admin is allowed to see them (a location admin only sees their own location). */
async function findTarget(req, res) {
  const scoped = !isGlobal(req.user);
  const row = await one(`${SELECT} WHERE u.id = ?${scoped ? " AND u.location_id = ?" : ""}`, scoped ? [req.params.id, req.user.locationId] : [req.params.id]);
  if (!row) {
    fail(res, 404, "User not found.");
    return null;
  }
  if (!isGlobal(req.user) && row.role === "GLOBAL_ADMIN") {
    fail(res, 403, "Only a global admin can change a global admin.");
    return null;
  }
  return row;
}

/** What a location admin may hand out: no global admins, and only their own location. Returns a message when it isn't allowed. */
function notAllowed(req, role, locationId) {
  if (isGlobal(req.user)) return null;
  if (role === "GLOBAL_ADMIN") return "Only a global admin can make another global admin.";
  if (locationId && locationId !== req.user.locationId) return "Location admins can only manage their own location.";
  return null;
}

async function activeLocation(name) {
  const location = await one("SELECT id, active FROM locations WHERE name = ?", [name]);
  if (!location) return { error: "That location doesn't exist." };
  if (!location.active) return { error: "That location is inactive." };
  return { id: location.id };
}

const isDuplicate = (err) => err?.code === "ER_DUP_ENTRY";

/** GET /api/users — a global admin sees everyone, a location admin only their own location */
router.get("/", async (req, res) => {
  const scoped = !isGlobal(req.user);
  const rows = await query(`${SELECT} ${scoped ? "WHERE u.location_id = ?" : ""} ORDER BY u.created_at DESC`, scoped ? [req.user.locationId] : []);
  res.json({ ok: true, items: rows.map(toApi) });
});

/** POST /api/users — creates the user with a one-time password, returned once so the admin can pass it on */
router.post("/", async (req, res) => {
  const parsed = Create.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const d = parsed.data;

  const location = await activeLocation(d.branch);
  if (location.error) return fail(res, 400, location.error);
  const blocked = notAllowed(req, d.role, location.id);
  if (blocked) return fail(res, 403, blocked);

  const id = randomUUID();
  const password = temporaryPassword();
  try {
    await query("INSERT INTO users (id, name, email, password_hash, role, location_id) VALUES (?, ?, ?, ?, ?, ?)", [id, d.name, d.email, await bcrypt.hash(password, 12), d.role, location.id]);
  } catch (err) {
    if (isDuplicate(err)) return fail(res, 409, "A user with this email already exists.");
    throw err;
  }
  await audit("USER_INVITED", "Security", req.user, { user: d.name });

  res.status(201).json({ ok: true, user: toApi(await one(`${SELECT} WHERE u.id = ?`, [id])), temporaryPassword: password });
});

/** PATCH /api/users/:id — any of name, email, role, branch */
router.patch("/:id", async (req, res) => {
  const target = await findTarget(req, res);
  if (!target) return;
  const parsed = Update.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const d = parsed.data;
  const self = target.id === req.user.id;

  let locationId = target.location_id;
  if (d.branch !== undefined && d.branch !== target.branch) {
    if (self) return fail(res, 403, "You can't move yourself to another location.");
    const location = await activeLocation(d.branch);
    if (location.error) return fail(res, 400, location.error);
    locationId = location.id;
  }

  const roleChanged = d.role !== undefined && d.role !== target.role;
  if (roleChanged && self) return fail(res, 403, "You can't change your own role.");
  const blocked = notAllowed(req, roleChanged ? d.role : null, locationId !== target.location_id ? locationId : null);
  if (blocked) return fail(res, 403, blocked);

  const name = d.name ?? target.name;
  const email = d.email ?? target.email;
  const role = d.role ?? target.role;
  try {
    await query("UPDATE users SET name = ?, email = ?, role = ?, location_id = ? WHERE id = ?", [name, email, role, locationId, target.id]);
  } catch (err) {
    if (isDuplicate(err)) return fail(res, 409, "A user with this email already exists.");
    throw err;
  }

  if (roleChanged) await audit("USER_ROLE_CHANGED", "Security", req.user, { user: name, role: role.replaceAll("_", " ") });
  if (name !== target.name || email !== target.email || locationId !== target.location_id) await audit("USER_UPDATED", "Security", req.user, { user: name });

  res.json({ ok: true, user: toApi(await one(`${SELECT} WHERE u.id = ?`, [target.id])) });
});

/** POST /api/users/:id/reset-password — sets a new one-time password and returns it once */
router.post("/:id/reset-password", async (req, res) => {
  const target = await findTarget(req, res);
  if (!target) return;

  const password = temporaryPassword();
  await query("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(password, 12), target.id]);
  await audit("USER_PASSWORD_RESET", "Security", req.user, { user: target.name });
  res.json({ ok: true, temporaryPassword: password });
});

/** DELETE /api/users/:id */
router.delete("/:id", async (req, res) => {
  const target = await findTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) return fail(res, 403, "You can't remove your own account.");

  // keep the visit history, just forget who the host was
  await query("UPDATE visits SET host_user_id = NULL WHERE host_user_id = ?", [target.id]);
  await query("DELETE FROM users WHERE id = ?", [target.id]);
  await audit("USER_REMOVED", "Security", req.user, { user: target.name });
  res.json({ ok: true });
});

export default router;
