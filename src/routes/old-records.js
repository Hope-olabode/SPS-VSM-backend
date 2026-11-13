import { Router } from "express";
import { one, query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { resolveUpload } from "../utils/uploads.js";

// Records moved out of the live tables by data retention (see utils/maintenance.js). Global admins only, for the location they are viewing.
const router = Router();
router.use(requireAuth, requireRole("GLOBAL_ADMIN"));

const SOURCES = { visit: "VISIT", pre_registration: "PRE_REGISTRATION", event_registration: "EVENT_REGISTRATION" };

/** GET /api/old-records?source=visit&q=ajayi&page=1&pageSize=25 (pageSize max 200) */
router.get("/", async (req, res) => {
  const page = Math.min(100000, Math.max(1, Math.floor(Number(req.query.page)) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(req.query.pageSize)) || 25));
  const where = ["location_id = ?"];
  const params = [req.user.locationId];
  if (SOURCES[req.query.source]) {
    where.push("source = ?");
    params.push(SOURCES[req.query.source]);
  }
  if (req.query.q) {
    const like = `%${String(req.query.q).trim()}%`;
    where.push("(name LIKE ? OR company LIKE ? OR phone LIKE ? OR host_name LIKE ?)");
    params.push(like, like, like, like);
  }
  const whereSql = where.join(" AND ");
  const rows = await query(`SELECT * FROM old_records WHERE ${whereSql} ORDER BY record_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  const { total } = await one(`SELECT COUNT(*) AS total FROM old_records WHERE ${whereSql}`, params);

  res.json({
    ok: true,
    total,
    page,
    items: rows.map((r) => ({
      id: r.id,
      source: r.source,
      originalId: r.original_id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      company: r.company,
      jobTitle: r.job_title,
      type: r.type,
      host: r.host_name,
      purpose: r.purpose,
      notes: r.notes,
      residentCompany: r.resident_company,
      floor: r.floor,
      status: r.status,
      eventTitle: r.event_title,
      recordAt: r.record_at,
      checkOutAt: r.check_out_at,
      autoCheckedOut: Boolean(r.auto_checked_out),
      documentsSigned: typeof r.documents_signed === "string" ? JSON.parse(r.documents_signed) : (r.documents_signed ?? []),
      hasPhoto: Boolean(r.photo_url),
      hasSignature: Boolean(r.signature_url),
      archivedAt: r.archived_at,
      anonymizedAt: r.anonymized_at, // set once the personal details were removed
    })),
  });
});

/** GET /api/old-records/:id/photo and /signature (until stage 2 deletes the files) */
for (const [kind, column] of [["photo", "photo_url"], ["signature", "signature_url"]]) {
  router.get(`/:id/${kind}`, async (req, res) => {
    const row = await one(`SELECT ${column} AS file FROM old_records WHERE id = ? AND location_id = ?`, [req.params.id, req.user.locationId]);
    const file = row?.file ? resolveUpload(row.file) : null;
    if (!file) return res.status(404).json({ ok: false, error: `No ${kind} saved for this record.` });
    res.set("Cache-Control", "private, no-store");
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).json({ ok: false, error: `No ${kind} saved for this record.` });
    });
  });
}

export default router;
