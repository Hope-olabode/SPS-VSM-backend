import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { one, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";

const router = Router();
router.use(requireAuth);

const adminOnly = requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN");
const fail = (res, status, error) => res.status(status).json({ ok: false, error });
const toApi = (t) => ({ id: t.id, name: t.name, floor: t.floor ?? undefined });

const Company = z.object({
  name: z.string().trim().min(1, "Enter the company's name").max(160, "The name can be at most 160 characters"),
  floor: z.string().trim().max(60, "The floor can be at most 60 characters").default(""),
});
const firstProblem = (error) => error.issues[0]?.message ?? "Check the details and try again.";
const isDuplicate = (err) => err?.code === "ER_DUP_ENTRY";

/** GET /api/tenants — the resident companies at the signed-in user's location, for the check-in dropdown */
router.get("/", async (req, res) => {
  const items = await query("SELECT id, name, floor FROM tenants WHERE location_id = ? ORDER BY name", [req.user.locationId]);
  res.json({ ok: true, items: items.map(toApi) });
});

/** POST /api/tenants { name, floor? } — admins add a resident company to their location (a name can only be used once per location) */
router.post("/", adminOnly, async (req, res) => {
  const parsed = Company.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const { name, floor } = parsed.data;

  const id = randomUUID();
  try {
    await query("INSERT INTO tenants (id, location_id, name, floor) VALUES (?, ?, ?, ?)", [id, req.user.locationId, name, floor || null]);
  } catch (err) {
    if (isDuplicate(err)) return fail(res, 409, "A resident company with this name already exists.");
    throw err;
  }
  await audit("RESIDENT_COMPANY_ADDED", "Security", req.user, { name });
  res.status(201).json({ ok: true, item: toApi({ id, name, floor }) });
});

/** PATCH /api/tenants/:id { name, floor? } — rename a resident company or change its floor (past visits keep pointing at it) */
router.patch("/:id", adminOnly, async (req, res) => {
  const tenant = await one("SELECT id FROM tenants WHERE id = ? AND location_id = ?", [req.params.id, req.user.locationId]);
  if (!tenant) return fail(res, 404, "Resident company not found.");
  const parsed = Company.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const { name, floor } = parsed.data;

  try {
    await query("UPDATE tenants SET name = ?, floor = ? WHERE id = ?", [name, floor || null, tenant.id]);
  } catch (err) {
    if (isDuplicate(err)) return fail(res, 409, "A resident company with this name already exists.");
    throw err;
  }
  await audit("RESIDENT_COMPANY_UPDATED", "Security", req.user, { name });
  res.json({ ok: true, item: toApi({ id: tenant.id, name, floor }) });
});

/** DELETE /api/tenants/:id — only when nothing uses it yet (no visits, pre-registrations or users), so history is never left pointing at nothing */
router.delete("/:id", adminOnly, async (req, res) => {
  const tenant = await one("SELECT id, name FROM tenants WHERE id = ? AND location_id = ?", [req.params.id, req.user.locationId]);
  if (!tenant) return fail(res, 404, "Resident company not found.");

  const used = await one(
    `SELECT (SELECT COUNT(*) FROM visits WHERE tenant_id = ?) + (SELECT COUNT(*) FROM pre_registrations WHERE tenant_id = ?) + (SELECT COUNT(*) FROM users WHERE tenant_id = ?) AS n`,
    [tenant.id, tenant.id, tenant.id],
  );
  if (Number(used.n) > 0) return fail(res, 409, "This company has visits, pre-registrations or users, so it can't be removed. You can rename it instead.");

  await query("DELETE FROM tenants WHERE id = ?", [tenant.id]);
  await audit("RESIDENT_COMPANY_REMOVED", "Security", req.user, { name: tenant.name });
  res.json({ ok: true });
});

export default router;
