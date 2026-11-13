import { Router } from "express";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { one, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";
import { buildPhone, PHONE_CODES, splitPhone } from "../utils/phone.js";

const router = Router();
router.use(requireAuth);

const fail = (res, status, error) => res.status(status).json({ ok: false, error });

// The date and time are formatted by MySQL so they come back exactly as they were typed, whatever time zone the server is in.
const SELECT = `SELECT p.id, p.name, p.email, p.phone, p.company, p.job_title, p.visitor_type, p.host_name, p.purpose, p.status, p.qr_code,
  DATE_FORMAT(p.expected_at, '%Y-%m-%d') AS expected_date, DATE_FORMAT(p.expected_at, '%l:%i %p') AS expected_time, t.name AS resident_company
  FROM pre_registrations p JOIN tenants t ON t.id = p.tenant_id`;

const toApi = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  company: row.company,
  jobTitle: row.job_title ?? undefined,
  expectedDate: row.expected_date,
  // a visit saved without a time is stored as midnight, so 12:00 AM means "no time"
  expectedTime: row.expected_time === "12:00 AM" ? "" : row.expected_time,
  residentCompany: row.resident_company,
  status: row.status.toLowerCase(),
  qrCode: row.qr_code,
  ...(row.phone ? splitPhone(row.phone) : {}),
  visitorType: row.visitor_type ?? undefined,
  host: row.host_name || undefined,
  purpose: row.purpose || undefined,
});

/** GET /api/pre-registrations — everyone expected at the signed-in user's location, latest expected date first */
router.get("/", async (req, res) => {
  const rows = await query(`${SELECT} WHERE t.location_id = ? ORDER BY p.expected_at DESC, p.created_at DESC LIMIT 2000`, [req.user.locationId]);
  res.json({ ok: true, items: rows.map(toApi) });
});

/** GET /api/pre-registrations/summary — the "Pre-Registered" number on the Overview */
router.get("/summary", async (req, res) => {
  const row = await one(
    "SELECT COUNT(*) AS n FROM pre_registrations p JOIN tenants t ON t.id = p.tenant_id WHERE t.location_id = ? AND p.status = 'EXPECTED' AND DATE(p.expected_at) = CURDATE()",
    [req.user.locationId],
  );
  res.json({ ok: true, expectedToday: Number(row.n) });
});

/**
 * GET /api/pre-registrations/lookup?code=PR-605309 — what the QR scanner calls. The pass holds only the code,
 * so the code is all that is looked up, and only at the signed-in user's location. Any status is returned
 * (the screen explains an already used or cancelled pass); expectedToday says whether the visit is for today.
 */
router.get("/lookup", async (req, res) => {
  const match = /PR-\d{6}/i.exec(String(req.query.code ?? ""));
  if (!match) return fail(res, 400, "That isn't a visitor pass. A pass code looks like PR-123456.");

  const row = await one(`${SELECT} WHERE p.qr_code = ? AND t.location_id = ?`, [match[0].toUpperCase(), req.user.locationId]);
  if (!row) return fail(res, 404, "No pre-registration with that code at this location.");

  const today = await one("SELECT DATE(expected_at) = CURDATE() AS today FROM pre_registrations WHERE id = ?", [row.id]);
  res.json({ ok: true, item: toApi(row), expectedToday: Boolean(today?.today) });
});

const TIME = /^(1[0-2]|[1-9]):[0-5]\d (AM|PM)$/;

/** "8:30 PM" -> "20:30:00" ("" means no time was picked, saved as midnight) */
function to24(time) {
  if (!time) return "00:00:00";
  const [, hour, minute, period] = /^(\d+):(\d\d) (AM|PM)$/.exec(time);
  return `${String((Number(hour) % 12) + (period === "PM" ? 12 : 0)).padStart(2, "0")}:${minute}:00`;
}

const isRealDate = (value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const Create = z.object({
  firstName: z.string().trim().min(1, "Enter the visitor's first name").max(80),
  lastName: z.string().trim().min(1, "Enter the visitor's last name").max(80),
  email: z
    .string()
    .trim()
    .max(190)
    .default("")
    .refine((value) => value === "" || /^\S+@\S+\.\S+$/.test(value), "Enter a valid email address"),
  phoneCode: z.string().default(""),
  phone: z.string().trim().default(""),
  company: z.string().trim().max(160).default(""),
  visitorType: z.string().trim().max(40).default("Guest"),
  residentCompany: z.string().trim().min(1, "Choose the resident company being visited"),
  host: z.string().trim().max(160).default(""),
  purpose: z.string().trim().max(255).default(""),
  expectedDate: z.string().refine(isRealDate, "Choose the expected date"),
  expectedTime: z.string().trim().default("").refine((value) => value === "" || TIME.test(value), "That time isn't valid."),
});

const firstProblem = (error) => Object.values(error.flatten().fieldErrors).flat()[0] ?? "Some details are missing or invalid.";

/** POST /api/pre-registrations */
router.post("/", async (req, res) => {
  const parsed = Create.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const d = parsed.data;

  if (!d.email && !d.phone) return fail(res, 400, "Enter an email or a phone number");

  let phone = null;
  if (d.phone) {
    const code = d.phoneCode || "+234";
    if (!PHONE_CODES.includes(code)) return fail(res, 400, "Choose a country code from the list.");
    const built = buildPhone(code, d.phone);
    if (built.error) return fail(res, 400, built.error);
    phone = built.phone;
  }

  // the resident company must be one at this user's location
  const tenant = await one("SELECT id FROM tenants WHERE name = ? AND location_id = ?", [d.residentCompany, req.user.locationId]);
  if (!tenant) return fail(res, 400, "Choose a resident company from the list.");

  const id = randomUUID();
  const name = `${d.firstName} ${d.lastName}`;
  const expectedAt = `${d.expectedDate} ${to24(d.expectedTime)}`;

  // the code on the visitor's pass has to be unique, so try again on the rare clash
  for (let attempt = 1; ; attempt++) {
    try {
      await query(
        "INSERT INTO pre_registrations (id, name, email, phone, company, visitor_type, tenant_id, host_name, purpose, expected_at, qr_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, name, d.email, phone, d.company, d.visitorType, tenant.id, d.host || null, d.purpose || null, expectedAt, `PR-${randomInt(100000, 1000000)}`],
      );
      break;
    } catch (err) {
      if (err?.code !== "ER_DUP_ENTRY" || attempt >= 5) throw err;
    }
  }
  await audit("PRE_REGISTRATION_CREATED", "Visitor", req.user, { visitor: name, residentCompany: d.residentCompany });

  res.status(201).json({ ok: true, item: toApi(await one(`${SELECT} WHERE p.id = ?`, [id])) });
});

/** DELETE /api/pre-registrations/:id — people who have already arrived stay on record */
router.delete("/:id", async (req, res) => {
  const row = await one(`${SELECT} WHERE p.id = ? AND t.location_id = ?`, [req.params.id, req.user.locationId]);
  if (!row) return fail(res, 404, "Pre-registration not found.");
  if (row.status === "CHECKED_IN" || row.status === "CHECKED_OUT") return fail(res, 409, "This visitor has already arrived, so the record has to stay.");

  await query("DELETE FROM pre_registrations WHERE id = ?", [row.id]);
  await audit("PRE_REGISTRATION_DELETED", "Visitor", req.user, { visitor: row.name, residentCompany: row.resident_company });
  res.json({ ok: true });
});

export default router;
