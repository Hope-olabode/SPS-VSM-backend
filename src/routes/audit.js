import { Router } from "express";
import { z } from "zod";
import { one, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";
import { describe } from "../utils/audit-messages.js";

const router = Router();
router.use(requireAuth);

const SELECT = "SELECT a.*, l.name AS location_name FROM audit_events a LEFT JOIN locations l ON l.id = a.location_id";

const toApi = (row) => ({
  id: String(row.id),
  seq: Number(row.id),
  action: row.action,
  category: row.category,
  actor: { name: row.actor_name, role: row.actor_role?.replaceAll("_", " ") ?? undefined },
  message: describe(row),
  location: row.location_name ?? undefined,
  createdAt: row.created_at,
});

/** GET /api/audit — newest first. A global admin sees every location, a location admin only their own. */
router.get("/", requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN"), async (req, res) => {
  const scoped = req.user.role !== "GLOBAL_ADMIN";
  const rows = await query(`${SELECT} ${scoped ? "WHERE a.location_id = ?" : ""} ORDER BY a.id DESC LIMIT 2000`, scoped ? [req.user.locationId] : []);
  res.json({ ok: true, items: rows.map(toApi) });
});

// Things only the browser can see happen (the evacuation is written by POST /api/visitors/check-out-all, which knows who was checked out). Everything else is written by the route that does the work.
// The server decides who did it and what the sentence says, so a client can't write its own text into the trail.
const CLIENT_ACTIONS = {
  REPORTS_VIEW: "Report",
  PII_UNLOCKED: "Security",
  EMERGENCY_ACTIVATED: "Security",
  EMERGENCY_DEACTIVATED: "Security",
};

const Body = z.object({
  action: z.enum(Object.keys(CLIENT_ACTIONS)),
  meta: z.object({ type: z.string().trim().max(80).optional() }).optional(),
});

/** POST /api/audit */
router.post("/", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "That action can't be recorded from the browser." });

  const { action, meta } = parsed.data;
  // only admins can unlock phone numbers, so only admins can write that event (the server already masks phones for everyone else)
  if (action === "PII_UNLOCKED" && !["GLOBAL_ADMIN", "LOCATION_ADMIN"].includes(req.user.role)) {
    return res.status(403).json({ ok: false, error: "Not allowed." });
  }
  const id = await audit(action, CLIENT_ACTIONS[action], req.user, meta ?? null);
  res.status(201).json({ ok: true, event: toApi(await one(`${SELECT} WHERE a.id = ?`, [id])) });
});

export default router;
