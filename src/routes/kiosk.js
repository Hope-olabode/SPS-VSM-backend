import { Router } from "express";
import { z } from "zod";
import { one, query } from "../db.js";
import { requireKioskCode, requireKioskToken, setKioskUnlocked } from "../middleware/kiosk-auth.js";
import { audit } from "../utils/audit.js";
import { CheckIn, performCheckIn } from "../utils/check-in.js";
import { PHONE_CODES, resolvePhone } from "../utils/phone.js";
import { checkKioskCode } from "../utils/kiosk-token.js";
import { rateLimit } from "../utils/rate-limit.js";
import { getSettings } from "../utils/settings.js";

// What the front-desk kiosk tablet calls. There is no login: the tablet sends its token in the x-kiosk-token header
// (the link an admin copies from the Overview or Control Panel), and the token decides which location it is for.
// On top of the token, every route except /unlock needs the tablet to have been unlocked with the location's 6-digit kiosk code
// (admins see it on the Locations page), so a copied link alone shows nothing. /unlock checks the code once and gives the
// tablet an httpOnly cookie as proof; the code is never kept on the tablet.
const router = Router();
router.use(requireKioskToken);

const Unlock = z.object({ code: z.string().trim().regex(/^\d{6}$/) });
// a 6-digit code has a million possibilities, so a handful of tries per IP is plenty for a person typing it in
const unlockLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, message: "Too many tries. Please wait a few minutes, or ask an admin for help." });

/** POST /api/kiosk/unlock { code } — the first thing a tablet does. Sets the tablet's proof cookie. 423 when the code is wrong; nothing else about the kiosk is revealed. */
router.post("/unlock", unlockLimit, async (req, res) => {
  const parsed = Unlock.safeParse(req.body);
  const { locationId, locationName } = req.kiosk;
  if (!parsed.success || !(await checkKioskCode(locationId, parsed.data.code))) {
    await audit("KIOSK_UNLOCK_FAILED", "Security", { name: "Kiosk", locationId }, { kiosk: locationName });
    return res.status(423).json({ ok: false, error: "That code isn't right. Ask an admin for this location's kiosk code." });
  }
  await setKioskUnlocked(res, req.kiosk);
  res.json({ ok: true });
});

router.use(requireKioskCode);

/** GET /api/kiosk/config — everything the kiosk screen needs to draw itself */
router.get("/config", async (req, res) => {
  const { locationId, locationName } = req.kiosk;
  const settings = await getSettings(locationId);
  const tenants = await query("SELECT id, name, floor FROM tenants WHERE location_id = ? ORDER BY name", [locationId]);
  const documents = await query("SELECT id, title, content FROM documents WHERE active = 1 AND require_signature = 1 ORDER BY created_at");

  res.json({
    ok: true,
    locationName,
    welcomeMessage: settings.welcomeMessage,
    allowWalkIns: settings.allowWalkIns,
    requirePhoto: settings.requirePhoto,
    requireSignature: settings.requireSignature,
    requireCheckoutClearance: settings.requireCheckoutClearance,
    tenants: tenants.map((t) => ({ id: t.id, name: t.name, floor: t.floor ?? undefined })),
    documents,
  });
});

/** POST /api/kiosk/check-in — a visitor checking themselves in. Same rules as staff check-in, plus "Allow walk-ins". */
router.post("/check-in", async (req, res) => {
  const parsed = CheckIn.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Some details are missing or invalid.", issues: parsed.error.flatten().fieldErrors });
  }
  const { locationId } = req.kiosk;
  const settings = await getSettings(locationId);
  const { status, body } = await performCheckIn({ data: parsed.data, locationId, actor: { name: "Kiosk", locationId }, settings, kiosk: true });
  res.status(status).json(body);
});

const Lookup = z.object({ phoneCode: z.enum(PHONE_CODES).default("+234"), phone: z.string().trim().min(1) });
// the lobby tablet is one IP address, so this is generous for real visitors but stops someone trying number after number
const lookupLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, message: "Too many lookups. Please see the front desk." });

/**
 * POST /api/kiosk/lookup { phone } — the first thing a visitor does at the kiosk: type their number.
 * It answers the questions that don't need the rest of the form, so the visitor finds out straight away:
 *  - 403 when the number is on the watchlist (and the watchlist is switched on), or when walk-ins are off and nobody expected them today.
 *    These are the same refusals the check-in gives at the end, with the same words; the watchlist hit is audited here too.
 *  - "expected": pre-registered for today, so their details come back to fill the form in (and they skip host approval).
 *  - "returning": has visited this location before, so their name and company come back.
 *  - "new": nothing known; they fill in the form.
 * requiresApproval says whether staff will have to let them in (the "Require host approval" setting, for visitors who weren't pre-registered).
 * It is a POST so the number stays out of URLs and logs. Whether someone is inside the building right now is never revealed here.
 */
router.post("/lookup", lookupLimit, async (req, res) => {
  const parsed = Lookup.safeParse(req.body);
  const phone = parsed.success ? resolvePhone(parsed.data.phoneCode, parsed.data.phone) : null;
  if (!phone) return res.status(400).json({ ok: false, error: "That phone number isn't valid." });

  const { locationId } = req.kiosk;
  const settings = await getSettings(locationId);

  if (settings.screenWatchlist) {
    const hit = await one("SELECT first_name, last_name, severity FROM watchlist WHERE phone = ? LIMIT 1", [phone]);
    if (hit) {
      await audit("WATCHLIST_MATCH", "Security", { name: "Kiosk", locationId }, { visitor: `${hit.first_name} ${hit.last_name}`, severity: hit.severity });
      return res.status(403).json({ ok: false, error: "This visitor can't be checked in. Please contact security." });
    }
  }

  // the same match the check-in uses to skip host approval
  const expected = await one(
    `SELECT p.name, p.company, p.visitor_type, p.host_name, p.purpose, t.name AS resident_company
       FROM pre_registrations p JOIN tenants t ON t.id = p.tenant_id
      WHERE p.phone = ? AND p.status = 'EXPECTED' AND t.location_id = ? AND DATE(p.expected_at) = CURDATE()
      ORDER BY p.expected_at LIMIT 1`,
    [phone, locationId],
  );

  if (!expected && !settings.allowWalkIns) {
    return res.status(403).json({ ok: false, error: "Walk-ins aren't accepted here. Only visitors who were pre-registered for today can check in. Please see the front desk." });
  }

  // "First Last Name" is stored as one string on a pre-registration
  const split = (name) => {
    const [firstName = "", ...rest] = name.trim().split(/\s+/);
    return { firstName, lastName: rest.join(" ") };
  };

  if (expected) {
    return res.json({
      ok: true,
      status: "expected",
      requiresApproval: false,
      visitor: {
        ...split(expected.name),
        company: expected.company,
        visitorType: expected.visitor_type ?? "",
        residentCompany: expected.resident_company,
        host: expected.host_name ?? "",
        purpose: expected.purpose ?? "",
      },
    });
  }

  // only someone who has visited this location before is recognised here, so one location can't see who has been to another
  const returning = await one(
    "SELECT p.id, p.first_name, p.last_name, p.company FROM visitors p WHERE p.phone = ? AND EXISTS (SELECT 1 FROM visits v WHERE v.visitor_id = p.id AND v.location_id = ?)",
    [phone, locationId],
  );
  // what they gave last time (visitor type, resident company, person visited), so the form can be filled in with one tap
  const last = returning
    ? await one(
        `SELECT v.type, v.host_name, t.name AS resident_company
           FROM visits v LEFT JOIN tenants t ON t.id = v.tenant_id
          WHERE v.visitor_id = ? AND v.location_id = ? ORDER BY v.check_in_at DESC LIMIT 1`,
        [returning.id, locationId],
      )
    : null;
  const requiresApproval = settings.requireHostApproval;
  if (returning) {
    return res.json({
      ok: true,
      status: "returning",
      requiresApproval,
      visitor: {
        firstName: returning.first_name,
        lastName: returning.last_name,
        company: returning.company,
        visitorType: last?.type ?? "",
        residentCompany: last?.resident_company ?? "",
        host: last?.host_name ?? "",
        purpose: "",
      },
    });
  }
  res.json({ ok: true, status: "new", requiresApproval });
});

/**
 * GET /api/kiosk/visits/:id/status — the kiosk asks whether staff have decided on a visitor who is waiting for approval.
 * Only the status comes back (no personal details), and only for a visit at this kiosk's own location.
 */
router.get("/visits/:id/status", async (req, res) => {
  const row = await one("SELECT status FROM visits WHERE id = ? AND location_id = ?", [req.params.id, req.kiosk.locationId]);
  if (!row) return res.status(404).json({ ok: false, error: "Visit not found." });
  const status = { PENDING_APPROVAL: "pending_approval", DECLINED: "declined" }[row.status] ?? "approved";
  res.json({ ok: true, status });
});

const Pass = z.object({ code: z.string().trim().min(1).max(64) });
const VISITOR_TYPES = ["Guest", "Contractor", "Vendor", "Interviewee", "Client", "Candidate"];

/** The pre-registration a scanned pass belongs to, if it can be used here and now. Returns { row } or { status, error }. */
async function findUsablePass(locationId, raw) {
  const match = /PR-\d{6}/i.exec(String(raw));
  if (!match) return { status: 400, error: "That isn't a visitor pass. Please try again, or see the front desk." };
  const row = await one(
    `SELECT p.id, p.name, p.company, p.visitor_type, p.host_name, p.purpose, p.phone, p.status,
            DATE(p.expected_at) = CURDATE() AS today, t.name AS resident_company
       FROM pre_registrations p JOIN tenants t ON t.id = p.tenant_id
      WHERE p.qr_code = ? AND t.location_id = ?`,
    [match[0].toUpperCase(), locationId],
  );
  if (!row) return { status: 404, error: "We couldn't find that pass at this location. Please see the front desk." };
  if (row.status !== "EXPECTED") return { status: 409, error: "This pass has already been used, or it was cancelled. Please see the front desk." };
  if (!row.today) return { status: 409, error: "This pass is for a different day. Please see the front desk." };
  return { row };
}

// "First Last Name" is stored as one string on a pre-registration
const splitName = (name) => {
  const [firstName = "", ...rest] = name.trim().split(/\s+/);
  return { firstName, lastName: rest.join(" ") || "-" };
};

/**
 * POST /api/kiosk/pass-lookup { code } — QR Express Check-In, step 1: the visitor scanned (or typed) the code from their pass.
 * Only a pass for today at this location that hasn't been used comes back, with what the form needs. needsPhone is true when the
 * pass was saved without a phone number, so the kiosk asks for it (checking out finds the visitor by phone).
 */
router.post("/pass-lookup", lookupLimit, async (req, res) => {
  const parsed = Pass.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "That isn't a visitor pass." });
  const found = await findUsablePass(req.kiosk.locationId, parsed.data.code);
  if (!found.row) return res.status(found.status).json({ ok: false, error: found.error });

  const { row } = found;
  res.json({
    ok: true,
    needsPhone: !row.phone,
    visitor: {
      ...splitName(row.name),
      company: row.company ?? "",
      visitorType: VISITOR_TYPES.includes(row.visitor_type) ? row.visitor_type : "Guest",
      residentCompany: row.resident_company,
      host: row.host_name ?? "",
      purpose: row.purpose ?? "",
    },
  });
});

const PassCheckIn = z.object({
  code: z.string().trim().min(1).max(64),
  /** only needed when the pass has no phone number saved */
  phoneCode: z.enum(PHONE_CODES).default("+234"),
  phone: z.string().trim().default(""),
  photo: z.string().optional(),
  signature: z.string().optional(),
});

/**
 * POST /api/kiosk/pass-check-in { code, phone?, photo?, signature? } — QR Express Check-In, step 2.
 * The pass gives the name, host and company, so the visitor doesn't fill the form in. The same rules apply as for any check-in
 * (watchlist, photo and signature settings); a pass was approved by whoever registered it, so there is no host approval.
 */
router.post("/pass-check-in", lookupLimit, async (req, res) => {
  const parsed = PassCheckIn.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "Some details are missing or invalid." });

  const { locationId } = req.kiosk;
  const found = await findUsablePass(locationId, parsed.data.code);
  if (!found.row) return res.status(found.status).json({ ok: false, error: found.error });
  const { row } = found;

  const data = CheckIn.safeParse({
    ...splitName(row.name),
    // a number saved on the pass is already "+<code><number>", so it keeps its own country code
    phoneCode: parsed.data.phoneCode,
    phone: row.phone || parsed.data.phone,
    company: row.company ?? "",
    visitorType: VISITOR_TYPES.includes(row.visitor_type) ? row.visitor_type : "Guest",
    residentCompany: row.resident_company,
    hostName: row.host_name ?? "",
    purpose: row.purpose ?? "",
    photo: parsed.data.photo,
    signature: parsed.data.signature,
    preRegistrationId: row.id,
  });
  if (!data.success) return res.status(400).json({ ok: false, error: "Please enter your phone number." });

  const settings = await getSettings(locationId);
  const { status, body } = await performCheckIn({ data: data.data, locationId, actor: { name: "Kiosk", locationId }, settings, kiosk: true, passVerified: true });
  res.status(status).json(body);
});

const CheckOut = z.object({ phoneCode: z.enum(PHONE_CODES).default("+234"), phone: z.string().trim().min(1) });

/**
 * POST /api/kiosk/check-out — a visitor leaving. With "Require staff clearance" on, the visit waits as PENDING_CLEARANCE
 * (staff approve it from the Overview or Visitor Log); otherwise they are checked out straight away.
 */
router.post("/check-out", async (req, res) => {
  const parsed = CheckOut.safeParse(req.body);
  const phone = parsed.success ? resolvePhone(parsed.data.phoneCode, parsed.data.phone) : null;
  if (!phone) return res.status(400).json({ ok: false, error: "That phone number isn't valid." });

  const { locationId } = req.kiosk;
  const visit = await one(
    `SELECT v.id, v.status, p.first_name, p.last_name
       FROM visits v JOIN visitors p ON p.id = v.visitor_id
      WHERE p.phone = ? AND v.location_id = ? AND v.status IN ('ONSITE', 'PENDING_CLEARANCE')
      ORDER BY v.check_in_at DESC LIMIT 1`,
    [phone, locationId],
  );
  // the same message whether the number is unknown or the visitor already left, so this can't be used to look people up
  if (!visit) return res.status(404).json({ ok: false, error: "We couldn't find a current visit for that number. Please see the front desk." });

  const actor = { name: "Kiosk", locationId };
  const visitor = `${visit.first_name} ${visit.last_name}`;

  if (visit.status === "PENDING_CLEARANCE") return res.json({ ok: true, status: "pending_clearance" });

  const { requireCheckoutClearance } = await getSettings(locationId);
  if (requireCheckoutClearance) {
    await query("UPDATE visits SET status = 'PENDING_CLEARANCE', clearance_requested_at = NOW() WHERE id = ?", [visit.id]);
    await audit("KIOSK_CHECKOUT_REQUESTED", "Visitor", actor, { visitId: visit.id, visitor, kiosk: req.kiosk.locationName });
    return res.json({ ok: true, status: "pending_clearance" });
  }

  await query("UPDATE visits SET status = 'LEFT', check_out_at = NOW() WHERE id = ?", [visit.id]);
  await query(
    "UPDATE pre_registrations p JOIN tenants t ON t.id = p.tenant_id SET p.status = 'CHECKED_OUT' WHERE p.phone = ? AND p.status = 'CHECKED_IN' AND t.location_id = ? AND DATE(p.expected_at) = CURDATE()",
    [phone, locationId],
  );
  await audit("VISITOR_CHECK_OUT", "Visitor", actor, { visitId: visit.id, visitor });
  res.json({ ok: true, status: "left" });
});

export default router;
