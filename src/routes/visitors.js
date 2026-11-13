import { Router } from "express";
import { one, pool, query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";
import { CheckIn, performCheckIn } from "../utils/check-in.js";
import { getSettings } from "../utils/settings.js";
import { resolveUpload } from "../utils/uploads.js";

const router = Router();
router.use(requireAuth); // everything below needs a signed-in user

const mask = (phone) => `${phone.slice(0, 6)} ••• ••${phone.slice(-2)}`;
/** admins always see full numbers; everyone else only when the Control Panel's "Mask phone numbers" is off */
async function canSeePhone(req) {
  if (["GLOBAL_ADMIN", "LOCATION_ADMIN"].includes(req.user.role)) return true;
  return !(await getSettings(req.user.locationId)).maskPhones;
}
const STATUS = { pending_approval: "PENDING_APPROVAL", onsite: "ONSITE", pending_clearance: "PENDING_CLEARANCE", left: "LEFT", declined: "DECLINED" };

/** GET /api/visitors?status=onsite&q=ajayi&page=1&pageSize=25 (pageSize max 500) */
router.get("/", async (req, res) => {
  const page = Math.min(100000, Math.max(1, Math.floor(Number(req.query.page)) || 1));
  const pageSize = Math.min(500, Math.max(1, Math.floor(Number(req.query.pageSize)) || 25));

  const where = ["v.location_id = ?"];
  const params = [req.user.locationId];

  if (STATUS[req.query.status]) {
    where.push("v.status = ?");
    params.push(STATUS[req.query.status]);
  }
  if (req.query.q) {
    const like = `%${String(req.query.q).trim()}%`;
    where.push("(p.first_name LIKE ? OR p.last_name LIKE ? OR p.company LIKE ? OR v.host_name LIKE ?)");
    params.push(like, like, like, like);
  }
  const whereSql = where.join(" AND ");

  const rows = await query(
    `SELECT v.id, v.type, v.host_name, v.status, v.check_in_at, v.check_out_at, v.clearance_requested_at,
            v.auto_checked_out, (v.status IN ('ONSITE', 'PENDING_CLEARANCE') AND v.check_in_at < DATE_SUB(NOW(), INTERVAL ? HOUR)) AS overstay,
            p.first_name, p.last_name, p.phone, p.company,
            t.name AS resident_company, t.floor
       FROM visits v
       JOIN visitors p ON p.id = v.visitor_id
       LEFT JOIN tenants t ON t.id = v.tenant_id
      WHERE ${whereSql}
      ORDER BY v.check_in_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    [Number((await getSettings(req.user.locationId)).overstayHours), ...params],
  );
  const { total } = await one(
    `SELECT COUNT(*) AS total FROM visits v JOIN visitors p ON p.id = v.visitor_id WHERE ${whereSql}`,
    params,
  );

  const seePhone = await canSeePhone(req);
  res.json({
    ok: true,
    total,
    page,
    items: rows.map((r) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      phone: seePhone ? r.phone : mask(r.phone),
      type: r.type,
      company: r.company,
      residentCompany: r.resident_company ?? "",
      floor: r.floor ?? undefined,
      host: r.host_name,
      status: r.status,
      checkInAt: r.check_in_at,
      checkOutAt: r.check_out_at,
      clearanceRequestedAt: r.clearance_requested_at,
      overstay: Boolean(r.overstay), // inside longer than the Control Panel's overstay threshold
      autoCheckedOut: Boolean(r.auto_checked_out), // the scheduled job checked them out
    })),
  });
});

/** POST /api/visitors — staff-assisted check-in (the check-in rules live in utils/check-in.js, shared with the kiosk) */
router.post("/", async (req, res) => {
  const parsed = CheckIn.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Some details are missing or invalid.", issues: parsed.error.flatten().fieldErrors });
  }
  const settings = await getSettings(req.user.locationId);
  const { status, body } = await performCheckIn({ data: parsed.data, locationId: req.user.locationId, actor: req.user, settings });
  res.status(status).json(body);
});

/**
 * POST /api/visitors/:id/approve and /decline — staff decide on a kiosk visitor who is waiting for host approval.
 * The UPDATE only matches a visit that is still PENDING_APPROVAL, so two people pressing the button can't both win.
 */
for (const [action, status, auditAction] of [["approve", "ONSITE", "VISITOR_APPROVED"], ["decline", "DECLINED", "VISITOR_DECLINED"]]) {
  router.post(`/:id/${action}`, async (req, res) => {
    const visit = await one(
      "SELECT v.id, v.status, p.first_name, p.last_name FROM visits v JOIN visitors p ON p.id = v.visitor_id WHERE v.id = ? AND v.location_id = ?",
      [req.params.id, req.user.locationId],
    );
    if (!visit) return res.status(404).json({ ok: false, error: "Visit not found." });

    const done = await query(
      "UPDATE visits SET status = ?, decided_by_id = ?, decided_at = NOW() WHERE id = ? AND status = 'PENDING_APPROVAL'",
      [status, req.user.id, visit.id],
    );
    if (done.affectedRows === 0) {
      return res.status(409).json({ ok: false, error: "This visitor is no longer waiting for approval. Refresh to see the latest." });
    }
    await audit(auditAction, "Visitor", req.user, { visitId: visit.id, visitor: `${visit.first_name} ${visit.last_name}` });
    res.json({ ok: true, status: status === "ONSITE" ? "onsite" : "declined" });
  });
}

/**
 * POST /api/visitors/:id/approve-clearance and /decline-clearance — staff answer a kiosk check-out that is waiting for clearance.
 * Approve checks the visitor out; decline puts them back as onsite. Only a visit that is still PENDING_CLEARANCE matches,
 * so two people pressing the button can't both win.
 */
router.post("/:id/approve-clearance", async (req, res) => {
  const visit = await one(
    "SELECT v.id, p.first_name, p.last_name, p.phone FROM visits v JOIN visitors p ON p.id = v.visitor_id WHERE v.id = ? AND v.location_id = ?",
    [req.params.id, req.user.locationId],
  );
  if (!visit) return res.status(404).json({ ok: false, error: "Visit not found." });

  const done = await query("UPDATE visits SET status = 'LEFT', check_out_at = NOW() WHERE id = ? AND status = 'PENDING_CLEARANCE'", [visit.id]);
  if (done.affectedRows === 0) return res.status(409).json({ ok: false, error: "This check-out is no longer waiting for clearance. Refresh to see the latest." });

  await query(
    "UPDATE pre_registrations p JOIN tenants t ON t.id = p.tenant_id SET p.status = 'CHECKED_OUT' WHERE p.phone = ? AND p.status = 'CHECKED_IN' AND t.location_id = ? AND DATE(p.expected_at) = CURDATE()",
    [visit.phone, req.user.locationId],
  );
  await audit("VISITOR_CLEARANCE_APPROVED", "Visitor", req.user, { visitId: visit.id, visitor: `${visit.first_name} ${visit.last_name}` });
  res.json({ ok: true, status: "left" });
});

router.post("/:id/decline-clearance", async (req, res) => {
  const visit = await one(
    "SELECT v.id, p.first_name, p.last_name FROM visits v JOIN visitors p ON p.id = v.visitor_id WHERE v.id = ? AND v.location_id = ?",
    [req.params.id, req.user.locationId],
  );
  if (!visit) return res.status(404).json({ ok: false, error: "Visit not found." });

  const done = await query("UPDATE visits SET status = 'ONSITE', clearance_requested_at = NULL WHERE id = ? AND status = 'PENDING_CLEARANCE'", [visit.id]);
  if (done.affectedRows === 0) return res.status(409).json({ ok: false, error: "This check-out is no longer waiting for clearance. Refresh to see the latest." });

  await audit("VISITOR_CLEARANCE_DECLINED", "Visitor", req.user, { visitId: visit.id, visitor: `${visit.first_name} ${visit.last_name}` });
  res.json({ ok: true, status: "onsite" });
});

/**
 * POST /api/visitors/check-out-all — emergency evacuation: checks out everyone still in the building at the signed-in
 * user's location (onsite, waiting for clearance, or waiting at the kiosk for approval) in one request.
 * It all happens in one transaction, so it is everyone or no one, and the audit event counts exactly who was checked out.
 * Writes one EMERGENCY_EVACUATION event (with the visit ids in its details) instead of one sign-out event per visitor.
 */
router.post("/check-out-all", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // lock everyone who is inside, so a decision made at the same moment can't change them under us
    const [inside] = await conn.execute(
      "SELECT id FROM visits WHERE location_id = ? AND status IN ('PENDING_APPROVAL', 'ONSITE', 'PENDING_CLEARANCE') FOR UPDATE",
      [req.user.locationId],
    );
    if (inside.length === 0) {
      await conn.commit();
      return res.json({ ok: true, count: 0 });
    }
    const ids = inside.map((row) => row.id);
    const marks = ids.map(() => "?").join(", ");

    // pre-registrations first (while these visits still count as inside): today's checked-in guests are now checked out
    await conn.execute(
      `UPDATE pre_registrations p JOIN tenants t ON t.id = p.tenant_id
          SET p.status = 'CHECKED_OUT'
        WHERE p.status = 'CHECKED_IN' AND t.location_id = ? AND DATE(p.expected_at) = CURDATE()
          AND p.phone IN (SELECT vi.phone FROM visitors vi JOIN visits v ON v.visitor_id = vi.id WHERE v.id IN (${marks}))`,
      [req.user.locationId, ...ids],
    );
    await conn.execute(`UPDATE visits SET status = 'LEFT', check_out_at = NOW(), clearance_requested_at = NULL WHERE id IN (${marks})`, ids);

    await audit("EMERGENCY_EVACUATION", "Security", req.user, { count: ids.length, visitIds: ids }, async (sql, params) => (await conn.execute(sql, params))[0]);
    await conn.commit();
    res.json({ ok: true, count: ids.length });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

/** POST /api/visitors/:id/check-out */
router.post("/:id/check-out", async (req, res) => {
  const visit = await one(
    "SELECT v.id, v.status, p.first_name, p.last_name, p.phone FROM visits v JOIN visitors p ON p.id = v.visitor_id WHERE v.id = ? AND v.location_id = ?",
    [req.params.id, req.user.locationId],
  );
  if (!visit) return res.status(404).json({ ok: false, error: "Visit not found." });
  if (visit.status === "LEFT") return res.status(409).json({ ok: false, error: "Already checked out." });
  if (visit.status === "DECLINED") return res.status(409).json({ ok: false, error: "This visitor was not let in, so there is nothing to check out." });

  await query("UPDATE visits SET status = 'LEFT', check_out_at = NOW() WHERE id = ?", [visit.id]);
  await query(
    "UPDATE pre_registrations p JOIN tenants t ON t.id = p.tenant_id SET p.status = 'CHECKED_OUT' WHERE p.phone = ? AND p.status = 'CHECKED_IN' AND t.location_id = ? AND DATE(p.expected_at) = CURDATE()",
    [visit.phone, req.user.locationId],
  );
  // staff signed them out (VISITOR_CHECK_OUT is for a visitor checking out by themselves at the kiosk)
  await audit("VISITOR_SIGN_OUT", "Visitor", req.user, { visitId: visit.id, visitor: `${visit.first_name} ${visit.last_name}` });
  res.json({ ok: true });
});

/**
 * GET /api/visitors/:id/photo and /api/visitors/:id/signature (:id is the visit id)
 * Only signed-in staff at the visit's location can open them, and they are never cached.
 */
for (const [kind, column] of [["photo", "photo_url"], ["signature", "signature_url"]]) {
  router.get(`/:id/${kind}`, async (req, res) => {
    const row = await one(`SELECT ${column} AS file FROM visits WHERE id = ? AND location_id = ?`, [req.params.id, req.user.locationId]);
    const file = row?.file ? resolveUpload(row.file) : null;
    if (!file) return res.status(404).json({ ok: false, error: `No ${kind} saved for this visit.` });

    res.set("Cache-Control", "private, no-store");
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).json({ ok: false, error: `No ${kind} saved for this visit.` });
    });
  });
}

/**
 * GET /api/visitors/:id (:id is the visit id) — everything the visitor details drawer shows.
 * Only a visit at the signed-in user's location is found. The photo and signature are not sent here:
 * hasPhoto / hasSignature say whether /:id/photo and /:id/signature have a file to open.
 * Earlier visits are limited to this location, so one location never sees where else a person has been.
 */
router.get("/:id", async (req, res) => {
  const r = await one(
    `SELECT v.id, v.visitor_id, v.type, v.purpose, v.notes, v.host_name, v.status, v.check_in_at, v.check_out_at,
            v.clearance_requested_at, v.decided_at, v.photo_url, v.signature_url,
            p.first_name, p.last_name, p.phone, p.email, p.company,
            t.name AS resident_company, t.floor,
            u.name AS decided_by
       FROM visits v
       JOIN visitors p ON p.id = v.visitor_id
       LEFT JOIN tenants t ON t.id = v.tenant_id
       LEFT JOIN users u ON u.id = v.decided_by_id
      WHERE v.id = ? AND v.location_id = ?`,
    [req.params.id, req.user.locationId],
  );
  if (!r) return res.status(404).json({ ok: false, error: "Visit not found." });

  const [documents, earlier, count] = await Promise.all([
    query(
      "SELECT d.title, s.signed_at FROM document_signatures s JOIN documents d ON d.id = s.document_id WHERE s.visit_id = ? ORDER BY s.signed_at",
      [r.id],
    ),
    query(
      "SELECT id, type, host_name, status, check_in_at, check_out_at FROM visits WHERE visitor_id = ? AND location_id = ? AND id <> ? ORDER BY check_in_at DESC LIMIT 5",
      [r.visitor_id, req.user.locationId, r.id],
    ),
    one("SELECT COUNT(*) AS total FROM visits WHERE visitor_id = ? AND location_id = ? AND id <> ?", [r.visitor_id, req.user.locationId, r.id]),
  ]);

  const seePhone = await canSeePhone(req);
  res.set("Cache-Control", "private, no-store");
  res.json({
    ok: true,
    visit: {
      id: r.id,
      name: `${r.first_name} ${r.last_name}`,
      phone: seePhone ? r.phone : mask(r.phone),
      email: r.email ?? "",
      company: r.company,
      type: r.type,
      purpose: r.purpose,
      notes: r.notes ?? "",
      host: r.host_name,
      residentCompany: r.resident_company ?? "",
      floor: r.floor ?? undefined,
      status: r.status,
      checkInAt: r.check_in_at,
      checkOutAt: r.check_out_at,
      clearanceRequestedAt: r.clearance_requested_at,
      decidedBy: r.decided_by ?? null,
      decidedAt: r.decided_at,
      hasPhoto: Boolean(r.photo_url && resolveUpload(r.photo_url)),
      hasSignature: Boolean(r.signature_url && resolveUpload(r.signature_url)),
      documentsSigned: documents.map((d) => ({ title: d.title, signedAt: d.signed_at })),
      earlierVisits: count.total,
      recentVisits: earlier.map((e) => ({ id: e.id, type: e.type, host: e.host_name, status: e.status, checkInAt: e.check_in_at, checkOutAt: e.check_out_at })),
    },
  });
});

export default router;
