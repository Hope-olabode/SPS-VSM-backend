import { Router } from "express";
import { one } from "../db.js";
import { isRegistrationToken, readAttendee, registerAttendee } from "../utils/event-registration.js";
import { rateLimit } from "../utils/rate-limit.js";

// No login here: these two routes are what the public registration page (/register/<token>) calls.
// The secret in the link is the only key, so they say as little as possible and the POST is rate limited.
const router = Router();

const fail = (res, status, error) => res.status(status).json({ ok: false, error });
const notFound = (res) => fail(res, 404, "This registration link isn't valid. Ask the organiser for a new one.");

/** GET /api/public/events/:token — what the registration page shows. Names no attendees and gives no head count, only whether there is room. */
router.get("/events/:token", async (req, res) => {
  if (!isRegistrationToken(req.params.token)) return notFound(res);

  const row = await one(
    `SELECT e.title, e.description, e.capacity, e.require_approval, l.name AS location,
            (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id) AS registered,
            e.ends_at < NOW() AS ended,
            DATE_FORMAT(e.starts_at, '%Y-%m-%d') AS start_date, DATE_FORMAT(e.starts_at, '%H:%i') AS start_time,
            DATE_FORMAT(e.ends_at, '%Y-%m-%d') AS end_date, DATE_FORMAT(e.ends_at, '%H:%i') AS end_time
       FROM events e JOIN locations l ON l.id = e.location_id
      WHERE e.registration_token = ?`,
    [req.params.token],
  );
  if (!row) return notFound(res);

  res.json({
    ok: true,
    event: {
      title: row.title,
      description: row.description ?? "",
      location: row.location,
      startDate: row.start_date,
      startTime: row.start_time,
      endDate: row.end_date,
      endTime: row.end_time,
      requireApproval: Boolean(row.require_approval),
      ended: Boolean(row.ended),
      full: Number(row.registered) >= row.capacity,
    },
  });
});

const limit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

/**
 * POST /api/public/events/:token/registrations — someone registers themselves.
 * { firstName, lastName, email?, phoneCode, phone, company? }. Answers status APPROVED, or PENDING when the event needs host approval.
 */
router.post("/events/:token/registrations", limit, async (req, res) => {
  if (!isRegistrationToken(req.params.token)) return notFound(res);

  const { attendee, error } = readAttendee(req.body);
  if (error) return fail(res, 400, error);

  const result = await registerAttendee({ where: "registration_token = ?", params: [req.params.token], attendee, selfService: true });
  if (result.error) return result.error.status === 404 ? notFound(res) : fail(res, result.error.status, result.error.message);
  res.status(201).json({ ok: true, status: result.status });
});

export default router;
