import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";
import { maskPhone } from "../utils/phone.js";
import { newRegistrationToken, readAttendee, registerAttendee } from "../utils/event-registration.js";
import { getSettings } from "../utils/settings.js";

const router = Router();
router.use(requireAuth);

const fail = (res, status, error) => res.status(status).json({ ok: false, error });

// Dates and times are formatted by MySQL so they come back exactly as they were typed, whatever time zone the server is in.
const SELECT = `SELECT e.id, e.title, e.capacity, (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id) AS registered, (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'PENDING') AS pending, e.description, e.require_nda, e.require_photo, e.require_approval, e.registration_token, l.name AS location,
  DATE_FORMAT(e.starts_at, '%Y-%m-%d') AS start_date, DATE_FORMAT(e.starts_at, '%H:%i') AS start_time,
  DATE_FORMAT(e.ends_at, '%Y-%m-%d') AS end_date, DATE_FORMAT(e.ends_at, '%H:%i') AS end_time
  FROM events e JOIN locations l ON l.id = e.location_id`;

const toApi = (row) => ({
  id: row.id,
  title: row.title,
  location: row.location,
  startDate: row.start_date,
  startTime: row.start_time,
  endDate: row.end_date,
  endTime: row.end_time,
  capacity: row.capacity,
  registered: Number(row.registered),
  /** registrations waiting for staff to approve them; they already hold a place */
  pending: Number(row.pending),
  description: row.description ?? "",
  requireNda: Boolean(row.require_nda),
  requirePhoto: Boolean(row.require_photo),
  requireApproval: Boolean(row.require_approval),
  /** the secret in the public registration link, /register/<token> */
  registrationToken: row.registration_token,
});

/** GET /api/events — this location's events, latest start first */
router.get("/", async (req, res) => {
  const rows = await query(`${SELECT} WHERE e.location_id = ? ORDER BY e.starts_at DESC, e.created_at DESC`, [req.user.locationId]);
  res.json({ ok: true, items: rows.map(toApi) });
});

/** GET /api/events/:id — one event at this location */
router.get("/:id", async (req, res) => {
  const row = await one(`${SELECT} WHERE e.id = ? AND e.location_id = ?`, [req.params.id, req.user.locationId]);
  if (!row) return fail(res, 404, "Event not found.");
  res.json({ ok: true, item: toApi(row) });
});

const MAX_CAPACITY = 500; // same limit as the form
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isRealDate = (value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const Create = z.object({
  title: z.string().trim().min(1, "Enter an event title").max(190),
  startDate: z.string().refine(isRealDate, "Choose a start date"),
  startTime: z.string().regex(TIME, "Choose a start time"),
  endDate: z.string().refine(isRealDate, "Choose an end date"),
  endTime: z.string().regex(TIME, "Choose an end time"),
  capacity: z.number().int().min(1).max(MAX_CAPACITY, `Capacity can be at most ${MAX_CAPACITY}`),
  description: z.string().trim().max(5000).default(""),
  requireNda: z.boolean().default(false),
  requirePhoto: z.boolean().default(false),
  requireApproval: z.boolean().default(false),
});

const firstProblem = (error) => Object.values(error.flatten().fieldErrors).flat()[0] ?? "Some details are missing or invalid.";

/** POST /api/events */
router.post("/", async (req, res) => {
  const parsed = Create.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const d = parsed.data;

  const startsAt = `${d.startDate} ${d.startTime}:00`;
  const endsAt = `${d.endDate} ${d.endTime}:00`;
  if (endsAt <= startsAt) return fail(res, 400, "The event must end after it starts.");

  const id = randomUUID();
  await query(
    "INSERT INTO events (id, location_id, title, starts_at, ends_at, capacity, description, require_nda, require_photo, require_approval, registration_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, req.user.locationId, d.title, startsAt, endsAt, d.capacity, d.description || null, d.requireNda ? 1 : 0, d.requirePhoto ? 1 : 0, d.requireApproval ? 1 : 0, newRegistrationToken()],
  );
  await audit("EVENT_CREATED", "Visitor", req.user, { title: d.title });

  res.status(201).json({ ok: true, item: toApi(await one(`${SELECT} WHERE e.id = ?`, [id])) });
});

/**
 * PATCH /api/events/:id — send the whole form, like POST.
 * The capacity can't go below the places already taken (pending registrations count). The event row is locked
 * while we check, so a registration can't slip in between the check and the update.
 */
router.patch("/:id", async (req, res) => {
  const parsed = Create.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, firstProblem(parsed.error));
  const d = parsed.data;

  const startsAt = `${d.startDate} ${d.startTime}:00`;
  const endsAt = `${d.endDate} ${d.endTime}:00`;
  if (endsAt <= startsAt) return fail(res, 400, "The event must end after it starts.");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[event]] = await conn.execute("SELECT id FROM events WHERE id = ? AND location_id = ? FOR UPDATE", [req.params.id, req.user.locationId]);
    if (!event) {
      await conn.rollback();
      return fail(res, 404, "Event not found.");
    }
    const [[{ taken }]] = await conn.execute("SELECT COUNT(*) AS taken FROM event_registrations WHERE event_id = ?", [event.id]);
    if (d.capacity < Number(taken)) {
      await conn.rollback();
      return fail(res, 409, `${taken} ${Number(taken) === 1 ? "person is" : "people are"} already registered, so the capacity can't be lower than ${taken}.`);
    }

    await conn.execute(
      "UPDATE events SET title = ?, starts_at = ?, ends_at = ?, capacity = ?, description = ?, require_nda = ?, require_photo = ?, require_approval = ? WHERE id = ?",
      [d.title, startsAt, endsAt, d.capacity, d.description || null, d.requireNda ? 1 : 0, d.requirePhoto ? 1 : 0, d.requireApproval ? 1 : 0, event.id],
    );
    await audit("EVENT_UPDATED", "Visitor", req.user, { title: d.title }, async (sql, params) => (await conn.execute(sql, params))[0]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  res.json({ ok: true, item: toApi(await one(`${SELECT} WHERE e.id = ?`, [req.params.id])) });
});

/** POST /api/events/:id/registration-link/regenerate — the old link stops working straight away */
router.post("/:id/registration-link/regenerate", async (req, res) => {
  const row = await one("SELECT id, title FROM events WHERE id = ? AND location_id = ?", [req.params.id, req.user.locationId]);
  if (!row) return fail(res, 404, "Event not found.");

  await query("UPDATE events SET registration_token = ? WHERE id = ?", [newRegistrationToken(), row.id]);
  await audit("EVENT_LINK_REGENERATED", "Security", req.user, { title: row.title });
  res.json({ ok: true, item: toApi(await one(`${SELECT} WHERE e.id = ?`, [row.id])) });
});

/** DELETE /api/events/:id */
router.delete("/:id", async (req, res) => {
  const row = await one("SELECT id, title FROM events WHERE id = ? AND location_id = ?", [req.params.id, req.user.locationId]);
  if (!row) return fail(res, 404, "Event not found.");

  await query("DELETE FROM events WHERE id = ?", [row.id]);
  await audit("EVENT_DELETED", "Visitor", req.user, { title: row.title });
  res.json({ ok: true });
});

// ───────── registrations: who is signed up for an event ─────────

const toRegistration = (row, canSeePhone) => ({
  id: row.id,
  name: row.name,
  email: row.email ?? "",
  // the same rule as the Visitor Log: admins always see full numbers, everyone else only when "Mask phone numbers" is off
  phone: canSeePhone ? row.phone : maskPhone(row.phone),
  company: row.company,
  status: row.status,
  registeredAt: row.created_at,
});

async function canSeePhones(user) {
  const settings = await getSettings(user.locationId);
  return ["GLOBAL_ADMIN", "LOCATION_ADMIN"].includes(user.role) || !settings.maskPhones;
}

/** GET /api/events/:id/registrations — newest first, with how many of the places are taken (pending ones count) */
router.get("/:id/registrations", async (req, res) => {
  const event = await one("SELECT id, capacity FROM events WHERE id = ? AND location_id = ?", [req.params.id, req.user.locationId]);
  if (!event) return fail(res, 404, "Event not found.");

  const [rows, canSeePhone] = await Promise.all([
    query("SELECT id, name, email, phone, company, status, created_at FROM event_registrations WHERE event_id = ? ORDER BY created_at DESC, id", [event.id]),
    canSeePhones(req.user),
  ]);
  res.json({
    ok: true,
    items: rows.map((row) => toRegistration(row, canSeePhone)),
    registered: rows.length,
    pending: rows.filter((row) => row.status === "PENDING").length,
    capacity: event.capacity,
  });
});

/**
 * POST /api/events/:id/registrations — staff register an attendee. Staff registrations are approved straight away.
 * 409 when the event is full, has ended, or that phone number is already registered.
 */
router.post("/:id/registrations", async (req, res) => {
  const { attendee, error } = readAttendee(req.body);
  if (error) return fail(res, 400, error);

  const result = await registerAttendee({ where: "id = ? AND location_id = ?", params: [req.params.id, req.user.locationId], attendee, user: req.user });
  if (result.error) return fail(res, result.error.status, result.error.message);
  res.status(201).json({ ok: true, item: toRegistration(result.row, true), registered: result.registered, capacity: result.capacity });
});

/** Finds a registration at this location, with its event's title */
const findRegistration = (req) =>
  one(
    `SELECT r.id, r.name, r.status, e.id AS event_id, e.title
       FROM event_registrations r JOIN events e ON e.id = r.event_id
      WHERE r.id = ? AND e.id = ? AND e.location_id = ?`,
    [req.params.registrationId, req.params.id, req.user.locationId],
  );

/** POST /api/events/:id/registrations/:registrationId/approve — lets a waiting registration in */
router.post("/:id/registrations/:registrationId/approve", async (req, res) => {
  const row = await findRegistration(req);
  if (!row) return fail(res, 404, "Registration not found.");
  if (row.status !== "PENDING") return fail(res, 409, `${row.name} is already approved.`);

  // the WHERE repeats the status check so two staff clicking at once approve (and audit) only once
  const result = await query("UPDATE event_registrations SET status = 'APPROVED' WHERE id = ? AND status = 'PENDING'", [row.id]);
  if (result.affectedRows === 0) return fail(res, 409, `${row.name} was already dealt with.`);
  await audit("EVENT_REGISTRATION_APPROVED", "Visitor", req.user, { eventId: row.event_id, title: row.title, name: row.name });
  res.json({ ok: true, item: toRegistration(await one("SELECT id, name, email, phone, company, status, created_at FROM event_registrations WHERE id = ?", [row.id]), true) });
});

/** POST /api/events/:id/registrations/:registrationId/decline — turns a waiting registration down and frees the place */
router.post("/:id/registrations/:registrationId/decline", async (req, res) => {
  const row = await findRegistration(req);
  if (!row) return fail(res, 404, "Registration not found.");
  if (row.status !== "PENDING") return fail(res, 409, `${row.name} is already approved. Remove them instead.`);

  const result = await query("DELETE FROM event_registrations WHERE id = ? AND status = 'PENDING'", [row.id]);
  if (result.affectedRows === 0) return fail(res, 409, `${row.name} was already dealt with.`);
  await audit("EVENT_REGISTRATION_DECLINED", "Visitor", req.user, { eventId: row.event_id, title: row.title, name: row.name });
  const { registered } = await one("SELECT COUNT(*) AS registered FROM event_registrations WHERE event_id = ?", [row.event_id]);
  res.json({ ok: true, registered: Number(registered) });
});

/** DELETE /api/events/:id/registrations/:registrationId — takes the person off the list and frees their place */
router.delete("/:id/registrations/:registrationId", async (req, res) => {
  const row = await one(
    `SELECT r.id, r.name, e.id AS event_id, e.title
       FROM event_registrations r JOIN events e ON e.id = r.event_id
      WHERE r.id = ? AND e.id = ? AND e.location_id = ?`,
    [req.params.registrationId, req.params.id, req.user.locationId],
  );
  if (!row) return fail(res, 404, "Registration not found.");

  await query("DELETE FROM event_registrations WHERE id = ?", [row.id]);
  await audit("EVENT_REGISTRATION_REMOVED", "Visitor", req.user, { eventId: row.event_id, title: row.title, name: row.name });
  const { registered } = await one("SELECT COUNT(*) AS registered FROM event_registrations WHERE event_id = ?", [row.event_id]);
  res.json({ ok: true, registered: Number(registered) });
});

export default router;
