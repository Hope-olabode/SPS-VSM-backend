import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";
import { buildPhone, PHONE_CODES, splitPhone } from "../utils/phone.js";

const router = Router();
router.use(requireAuth); // everyone signed in can read the list

// Only these roles may add or remove entries. Change the list here if your security staff use another role.
const canManage = requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN", "MANAGER");

const SEVERITIES = ["Low", "Medium", "High", "Critical"]; // the frontend spells them like this; the database stores LOW, MEDIUM...
const titleCase = (value) => value[0] + value.slice(1).toLowerCase();

const Entry = z.object({
  firstName: z.string().trim().min(1, "Enter a first name"),
  lastName: z.string().trim().min(1, "Enter a last name"),
  email: z
    .string()
    .trim()
    .default("")
    .refine((value) => value === "" || /^\S+@\S+\.\S+$/.test(value), "Enter a valid email address"),
  phoneCode: z.enum(PHONE_CODES).default("+234"),
  phone: z.string().trim().default(""),
  company: z.string().trim().default(""),
  severity: z.enum(SEVERITIES).default("Medium"),
  reason: z.string().trim().min(1, "Describe the reason for watchlisting"),
});

const toApi = (row) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email ?? "",
  ...splitPhone(row.phone),
  company: row.company,
  severity: titleCase(row.severity),
  reason: row.reason,
  createdAt: row.created_at,
});

/** GET /api/watchlist — newest first */
router.get("/", async (_req, res) => {
  const rows = await query("SELECT * FROM watchlist ORDER BY created_at DESC");
  res.json({ ok: true, items: rows.map(toApi) });
});

/** POST /api/watchlist */
router.post("/", canManage, async (req, res) => {
  const parsed = Entry.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const first = Object.values(issues).flat()[0];
    return res.status(400).json({ ok: false, error: first ?? "Some details are missing or invalid.", issues });
  }
  const d = parsed.data;

  const { phone, error } = buildPhone(d.phoneCode, d.phone);
  if (error) return res.status(400).json({ ok: false, error });

  if (phone && (await one("SELECT id FROM watchlist WHERE phone = ? LIMIT 1", [phone]))) {
    return res.status(409).json({ ok: false, error: "Someone with that phone number is already on the watchlist." });
  }

  const id = randomUUID();
  await query(
    "INSERT INTO watchlist (id, first_name, last_name, email, phone, company, severity, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, d.firstName, d.lastName, d.email || null, phone, d.company, d.severity.toUpperCase(), d.reason],
  );
  await audit("WATCHLIST_ADDED", "Security", req.user, { entryId: id, name: `${d.firstName} ${d.lastName}`, severity: d.severity });

  res.status(201).json({ ok: true, entry: toApi(await one("SELECT * FROM watchlist WHERE id = ?", [id])) });
});

/**
 * POST /api/watchlist/from-visit/:visitId — puts the person behind a visit on the watchlist (the Visitor Log's "Add to Watchlist").
 * The name, phone, email and company come from the visit itself, so the full phone number is saved even when staff only see it masked.
 */
router.post("/from-visit/:visitId", canManage, async (req, res) => {
  const parsed = z
    .object({
      severity: z.enum(SEVERITIES).default("Medium"),
      reason: z.string().trim().min(1, "Describe the reason for watchlisting"),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0];
    return res.status(400).json({ ok: false, error: first ?? "Some details are missing or invalid." });
  }

  const visit = await one(
    `SELECT p.first_name, p.last_name, p.phone, p.email, p.company
       FROM visits v JOIN visitors p ON p.id = v.visitor_id
      WHERE v.id = ? AND v.location_id = ?`,
    [req.params.visitId, req.user.locationId],
  );
  if (!visit) return res.status(404).json({ ok: false, error: "Visit not found." });

  if (visit.phone && (await one("SELECT id FROM watchlist WHERE phone = ? LIMIT 1", [visit.phone]))) {
    return res.status(409).json({ ok: false, error: "This visitor is already on the watchlist." });
  }

  const id = randomUUID();
  const d = parsed.data;
  await query(
    "INSERT INTO watchlist (id, first_name, last_name, email, phone, company, severity, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, visit.first_name, visit.last_name, visit.email || null, visit.phone, visit.company ?? "", d.severity.toUpperCase(), d.reason],
  );
  await audit("WATCHLIST_ADDED", "Security", req.user, { entryId: id, name: `${visit.first_name} ${visit.last_name}`, severity: d.severity });

  res.status(201).json({ ok: true, entry: toApi(await one("SELECT * FROM watchlist WHERE id = ?", [id])) });
});

/** DELETE /api/watchlist/:id */
router.delete("/:id", canManage, async (req, res) => {
  const row = await one("SELECT id, first_name, last_name FROM watchlist WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ ok: false, error: "Entry not found." });

  await query("DELETE FROM watchlist WHERE id = ?", [row.id]);
  await audit("WATCHLIST_REMOVED", "Security", req.user, { entryId: row.id, name: `${row.first_name} ${row.last_name}` });
  res.json({ ok: true });
});

export default router;
