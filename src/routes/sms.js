import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";
import { normalizeNigerianPhone } from "../utils/phone.js";
import { MAX_RECIPIENTS, MAX_SEGMENTS, smsInfo } from "../utils/sms.js";
import { deliver, smsMode } from "../utils/sms-provider.js";

const router = Router();
// the same roles that can open the Marketing page; checked here too, so the page being hidden is not the only lock
router.use(requireAuth, requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN", "MANAGER"));

const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });

/** GET /api/sms/mode — tells the Marketing page whether messages will really be delivered */
router.get("/mode", (_req, res) => res.json({ ok: true, mode: smsMode() }));

/** GET /api/sms/contacts — everyone who has visited this location, once per person, with their latest visitor type */
router.get("/contacts", async (req, res) => {
  const rows = await query(
    `SELECT p.phone, CONCAT(p.first_name, ' ', p.last_name) AS name, p.company,
            SUBSTRING_INDEX(GROUP_CONCAT(v.type ORDER BY v.check_in_at DESC SEPARATOR '|'), '|', 1) AS type
       FROM visitors p JOIN visits v ON v.visitor_id = p.id
      WHERE v.location_id = ? AND v.status NOT IN ('PENDING_APPROVAL', 'DECLINED')
      GROUP BY p.id, p.phone, p.first_name, p.last_name, p.company
      ORDER BY MAX(v.check_in_at) DESC
      LIMIT 5000`,
    [req.user.locationId],
  );
  res.json({ ok: true, items: rows.map((r) => ({ phone: r.phone, name: r.name, company: r.company ?? "", type: r.type })) });
});

/** GET /api/sms/campaigns — recent sends. A global admin sees everyone's, others only their own location's. */
router.get("/campaigns", async (req, res) => {
  const global = req.user.role === "GLOBAL_ADMIN";
  const rows = await query(
    `SELECT c.id, c.message, c.accepted, c.failed, c.mode, c.created_at, u.name AS sent_by
       FROM sms_campaigns c LEFT JOIN users u ON u.id = c.sent_by_id
      WHERE (? = 1 OR u.location_id = ?)
      ORDER BY c.created_at DESC LIMIT 50`,
    [global ? 1 : 0, req.user.locationId],
  );
  res.json({
    ok: true,
    items: rows.map((r) => ({
      id: r.id,
      message: r.message,
      recipients: r.accepted,
      failed: r.failed,
      segments: smsInfo(r.message).segments,
      testMode: r.mode !== "live",
      sentBy: r.sent_by ?? undefined,
      createdAt: r.created_at,
    })),
  });
});

/** POST /api/sms/send  { message, recipients: ["+2348012345678", ...] } */
router.post("/send", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) return fail(res, 400, "Write a message first.");

  const info = smsInfo(message);
  if (info.segments > MAX_SEGMENTS) return fail(res, 400, `That message is ${info.segments} SMS long. The limit is ${MAX_SEGMENTS}.`);

  const recipients = req.body?.recipients;
  if (!Array.isArray(recipients) || recipients.length === 0) return fail(res, 400, "Choose at least one recipient.");
  if (recipients.length > MAX_RECIPIENTS) return fail(res, 400, `You can send to at most ${MAX_RECIPIENTS} people at a time.`);

  // never trust the browser's list: validate and de-duplicate here
  const valid = new Set();
  let invalid = 0;
  for (const item of recipients) {
    const phone = typeof item === "string" ? normalizeNigerianPhone(item) : null;
    if (phone) valid.add(phone);
    else invalid++;
  }
  if (valid.size === 0) return fail(res, 400, "None of the phone numbers are valid.", { invalid });

  const result = await deliver([...valid], message);

  // keep a record of every attempt, including ones that failed
  await query("INSERT INTO sms_campaigns (id, message, recipients, accepted, failed, mode, sent_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    randomUUID(),
    message,
    valid.size,
    result.accepted,
    result.failed,
    result.mode,
    req.user.id,
  ]);

  const ok = result.accepted > 0;
  if (ok) await audit("SMS_CAMPAIGN_SENT", "Visitor", req.user, { count: result.accepted, testMode: result.mode !== "live" });

  res.status(ok ? 200 : 502).json({
    ok,
    mode: result.mode,
    accepted: result.accepted,
    failed: result.failed,
    invalid,
    segments: info.segments,
    error: ok ? undefined : (result.error ?? "The message could not be sent."),
  });
});

export default router;
