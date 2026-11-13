import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";
import { listKioskCodes, regenerateKioskCode } from "../utils/kiosk-token.js";

const router = Router();
router.use(requireAuth);

const fail = (res, status, error) => res.status(status).json({ ok: false, error });
const globalOnly = requireRole("GLOBAL_ADMIN");

const SELECT = "SELECT id, name, address, city, active, is_primary, created_at FROM locations";

const toApi = (row) => ({
  id: row.id,
  name: row.name,
  address: row.address,
  city: row.city,
  status: row.active ? "active" : "inactive",
  primary: Boolean(row.is_primary),
  createdAt: row.created_at,
});

const Entry = z.object({
  name: z.string().trim().min(1, "Enter a name for this location").max(120),
  city: z.string().trim().min(1, "Enter the city and country").max(120),
  address: z.string().trim().max(255).default(""),
  status: z.enum(["active", "inactive"]).default("active"),
});

const firstProblem = (error) => Object.values(error.flatten().fieldErrors).flat()[0] ?? "Some details are missing or invalid.";
const isDuplicate = (err) => err?.code === "ER_DUP_ENTRY";

/** GET /api/locations — a global admin sees every location, everyone else only their own */
router.get("/", async (req, res) => {
  const global = req.user.role === "GLOBAL_ADMIN";
  const rows = await query(`${SELECT} ${global ? "" : "WHERE id = ?"} ORDER BY is_primary DESC, created_at`, global ? [] : [req.user.locationId]);
  res.json({ ok: true, items: rows.map(toApi) });
});

/** GET /api/locations/kiosk-codes — global admins only: every location's kiosk code, so it can be given to whoever sets up a tablet */
router.get("/kiosk-codes", globalOnly, async (req, res) => {
  res.json({ ok: true, items: await listKioskCodes() });
});

/** POST /api/locations/:id/kiosk-code/regenerate — a new code for one location */
router.post("/:id/kiosk-code/regenerate", globalOnly, async (req, res) => {
  const location = await one(`${SELECT} WHERE id = ?`, [req.params.id]);
  if (!location) return fail(res, 404, "Location not found.");
  const code = await regenerateKioskCode(location.id);
  await audit("KIOSK_CODE_REGENERATED", "Security", req.user, { location: location.name });
  res.json({ ok: true, locationId: location.id, code });
});

/** POST /api/locations */
router.post("/", globalOnly, async (req, res) => {
  const parsed = Entry.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const d = parsed.data;

  const id = randomUUID();
  try {
    await query("INSERT INTO locations (id, name, address, city, active) VALUES (?, ?, ?, ?, ?)", [id, d.name, d.address, d.city, d.status === "active" ? 1 : 0]);
  } catch (err) {
    if (isDuplicate(err)) return fail(res, 409, "A location with this name already exists.");
    throw err;
  }
  await audit("LOCATION_CREATED", "Security", req.user, { name: d.name });
  res.status(201).json({ ok: true, location: toApi(await one(`${SELECT} WHERE id = ?`, [id])) });
});

/** PATCH /api/locations/:id — send the whole form (name, city, address, status) */
router.patch("/:id", globalOnly, async (req, res) => {
  const location = await one(`${SELECT} WHERE id = ?`, [req.params.id]);
  if (!location) return fail(res, 404, "Location not found.");

  const parsed = Entry.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const d = parsed.data;
  if (location.is_primary && d.status === "inactive") return fail(res, 400, "The primary location always stays active.");

  try {
    await query("UPDATE locations SET name = ?, address = ?, city = ?, active = ? WHERE id = ?", [d.name, d.address, d.city, d.status === "active" ? 1 : 0, location.id]);
  } catch (err) {
    if (isDuplicate(err)) return fail(res, 409, "A location with this name already exists.");
    throw err;
  }
  await audit("LOCATION_UPDATED", "Security", req.user, { name: d.name });
  res.json({ ok: true, location: toApi(await one(`${SELECT} WHERE id = ?`, [location.id])) });
});

/** DELETE /api/locations/:id — only an empty, non-primary location can go */
router.delete("/:id", globalOnly, async (req, res) => {
  const location = await one(`${SELECT} WHERE id = ?`, [req.params.id]);
  if (!location) return fail(res, 404, "Location not found.");
  if (location.is_primary) return fail(res, 409, "The primary location can't be removed.");

  const team = await one("SELECT COUNT(*) AS n FROM users WHERE location_id = ?", [location.id]);
  if (Number(team.n) > 0) return fail(res, 409, `Move the ${team.n} ${Number(team.n) === 1 ? "user" : "users"} assigned here to another location first.`);

  try {
    await query("DELETE FROM locations WHERE id = ?", [location.id]);
  } catch (err) {
    // visits, resident companies and so on still point at it
    if (err?.code === "ER_ROW_IS_REFERENCED_2") return fail(res, 409, "This location still has visitor records or other data, so it can't be removed. Mark it inactive instead.");
    throw err;
  }
  await audit("LOCATION_REMOVED", "Security", req.user, { name: location.name });
  res.json({ ok: true });
});

export default router;
