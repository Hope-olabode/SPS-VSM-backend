import { pool, query } from "../db.js";
import { audit } from "./audit.js";
import { getSettings } from "./settings.js";
import { deleteUpload } from "./uploads.js";

// The scheduled maintenance job. It reads each location's Control Panel settings and does three things:
//   1. Auto check-out   (autoCheckout)  checks out visitors who were never signed out
//   2. Overstay flags   (overstayHours) marks visits that passed the threshold, once, and writes an audit event
//   3. Data retention   (retentionDays) moves old records into the old_records table, and anonymises those once they are very old (see applyRetention)
// It is safe to run as often as you like: every step only touches rows that still need it. Times use the database's clock (NOW()),
// the same as the rest of the API.

const BATCH = 200;
const IN_BUILDING = "('ONSITE', 'PENDING_CLEARANCE')";
const SYSTEM = (locationId) => ({ name: "System", locationId });

/** 1. Check out visitors who stayed past the location's auto check-out rule. Their check-out time is the moment the rule fired, not "now". */
async function autoCheckOut(locationId, setting) {
  if (setting === "never") return 0;
  const hours = Number(setting);
  // end_of_day: anyone who arrived on an earlier day, checked out at 23:59:59 of their arrival day. "8" / "12": that many hours after arrival.
  const due = hours ? "v.check_in_at < DATE_SUB(NOW(), INTERVAL ? HOUR)" : "v.check_in_at < CURDATE()";
  const outAt = hours ? "DATE_ADD(check_in_at, INTERVAL ? HOUR)" : "TIMESTAMP(DATE(check_in_at), '23:59:59')";
  const extra = hours ? [hours] : [];

  let total = 0;
  for (;;) {
    const rows = await query(
      `SELECT v.id, p.first_name, p.last_name FROM visits v JOIN visitors p ON p.id = v.visitor_id
        WHERE v.location_id = ? AND v.status IN ${IN_BUILDING} AND ${due} LIMIT ${BATCH}`,
      [locationId, ...extra],
    );
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(", ");
    // pre-registered guests who were checked in today are checked out with them (same rule as every other check-out)
    await query(
      `UPDATE pre_registrations pr JOIN tenants t ON t.id = pr.tenant_id
          SET pr.status = 'CHECKED_OUT'
        WHERE pr.status = 'CHECKED_IN' AND t.location_id = ?
          AND pr.phone IN (SELECT vi.phone FROM visitors vi JOIN visits v ON v.visitor_id = vi.id WHERE v.id IN (${marks}))
          AND DATE(pr.expected_at) IN (SELECT DATE(v.check_in_at) FROM visits v WHERE v.id IN (${marks}))`,
      [locationId, ...ids, ...ids],
    );
    // the status is checked again, so a person who signed the visitor out a moment ago wins
    const done = await query(
      `UPDATE visits SET status = 'LEFT', check_out_at = ${outAt}, auto_checked_out = 1, clearance_requested_at = NULL
        WHERE id IN (${marks}) AND status IN ${IN_BUILDING}`,
      [...extra, ...ids],
    );
    for (const r of rows) await audit("VISITOR_AUTO_CHECK_OUT", "Visitor", SYSTEM(locationId), { visitId: r.id, visitor: `${r.first_name} ${r.last_name}`, rule: setting });
    total += done.affectedRows;
    if (rows.length < BATCH) break;
  }
  return total;
}

/** 2. Flag visits that passed the overstay threshold. A visit is flagged once. */
async function flagOverstays(locationId, hours) {
  const rows = await query(
    `SELECT v.id, v.host_name, p.first_name, p.last_name FROM visits v JOIN visitors p ON p.id = v.visitor_id
      WHERE v.location_id = ? AND v.status IN ${IN_BUILDING} AND v.overstay_flagged_at IS NULL
        AND v.check_in_at < DATE_SUB(NOW(), INTERVAL ? HOUR) LIMIT 500`,
    [locationId, Number(hours)],
  );
  for (const r of rows) {
    const done = await query("UPDATE visits SET overstay_flagged_at = NOW() WHERE id = ? AND overstay_flagged_at IS NULL", [r.id]);
    if (done.affectedRows) await audit("VISITOR_OVERSTAY", "Security", SYSTEM(locationId), { visitId: r.id, visitor: `${r.first_name} ${r.last_name}`, host: r.host_name, hours: Number(hours) });
  }
  return rows.length;
}

const ARCHIVE_COLUMNS = "id, source, original_id, location_id, name, phone, email, company, job_title, type, host_name, purpose, notes, resident_company, floor, status, event_title, record_at, check_out_at, auto_checked_out, photo_url, signature_url, documents_signed";

/** Run several statements in one transaction: all of them or none */
async function inTransaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await work((sql, params) => conn.execute(sql, params));
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Stage 2 age, in days: records in old_records older than this lose their personal details. Never less than a day past the location's retention. */
const anonymizeAfterDays = (retentionDays) => Math.max(Number(process.env.ARCHIVE_ANONYMIZE_DAYS) || 1095, Number(retentionDays) + 1);

/**
 * 3. Data retention, in two stages.
 *   Stage 1 (retentionDays): visits that are over (left or declined), pre-registrations (by expected date) and event registrations
 *     (by the end of the event) older than the setting are MOVED into old_records and deleted from their live tables. A visitor
 *     with no visits left is deleted too. Each move is one transaction, so a record is never in both places or in neither.
 *     Photo and signature files stay on disk, now referenced by old_records.
 *   Stage 2 (ARCHIVE_ANONYMIZE_DAYS, default 1095 = 3 years): old_records older than that keep their dates, type, host and
 *     company-of-visit but lose name, phone, email, company, notes, job title, signed-document list, and their photo and signature files.
 * The watchlist and the audit trail are not touched.
 */
async function applyRetention(locationId, days, { dryRun = false } = {}) {
  const result = { archivedVisits: 0, archivedPreRegistrations: 0, archivedEventRegistrations: 0, anonymized: 0 };
  const d = Number(days);
  const age = "DATE_SUB(NOW(), INTERVAL ? DAY)";
  const stage2 = anonymizeAfterDays(d);

  if (dryRun) {
    const count = async (sql, params) => Number((await query(sql, params))[0].n);
    result.archivedVisits = await count(`SELECT COUNT(*) AS n FROM visits WHERE location_id = ? AND status IN ('LEFT', 'DECLINED') AND check_in_at < ${age}`, [locationId, d]);
    result.archivedPreRegistrations = await count(`SELECT COUNT(*) AS n FROM pre_registrations pr JOIN tenants t ON t.id = pr.tenant_id WHERE t.location_id = ? AND pr.expected_at < ${age}`, [locationId, d]);
    result.archivedEventRegistrations = await count(`SELECT COUNT(*) AS n FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE e.location_id = ? AND e.ends_at < ${age}`, [locationId, d]);
    result.anonymized = await count(`SELECT COUNT(*) AS n FROM old_records WHERE location_id = ? AND anonymized_at IS NULL AND record_at < ${age}`, [locationId, stage2]);
    return result;
  }

  // ── stage 1a: visits ──
  for (;;) {
    const rows = await query(
      `SELECT id, visitor_id FROM visits WHERE location_id = ? AND status IN ('LEFT', 'DECLINED') AND check_in_at < ${age} LIMIT ${BATCH}`,
      [locationId, d],
    );
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(", ");
    const people = [...new Set(rows.map((r) => r.visitor_id))];

    await inTransaction(async (run) => {
      await run(
        `INSERT INTO old_records (${ARCHIVE_COLUMNS})
         SELECT UUID(), 'VISIT', v.id, v.location_id, CONCAT(p.first_name, ' ', p.last_name), p.phone, p.email, p.company, NULL, v.type, v.host_name, v.purpose, v.notes,
                t.name, t.floor, v.status, v.check_in_at, v.check_out_at, v.auto_checked_out, v.photo_url, v.signature_url,
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('title', d.title, 'signedAt', ds.signed_at)) FROM document_signatures ds JOIN documents d ON d.id = ds.document_id WHERE ds.visit_id = v.id)
           FROM visits v JOIN visitors p ON p.id = v.visitor_id LEFT JOIN tenants t ON t.id = v.tenant_id
          WHERE v.id IN (${marks})`,
        ids,
      );
      await run(`DELETE FROM visits WHERE id IN (${marks})`, ids); // the signed-document rows go with them (ON DELETE CASCADE)
      // a person with no visits left has nothing to link to any more (their details now live only in old_records)
      await run(
        `DELETE FROM visitors WHERE id IN (${people.map(() => "?").join(", ")}) AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.visitor_id = visitors.id)`,
        people,
      );
    });
    result.archivedVisits += ids.length;
    if (rows.length < BATCH) break;
  }

  // ── stage 1b: pre-registrations ──
  for (;;) {
    const rows = await query(
      `SELECT pr.id FROM pre_registrations pr JOIN tenants t ON t.id = pr.tenant_id WHERE t.location_id = ? AND pr.expected_at < ${age} LIMIT ${BATCH}`,
      [locationId, d],
    );
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(", ");
    await inTransaction(async (run) => {
      await run(
        `INSERT INTO old_records (id, source, original_id, location_id, name, phone, email, company, job_title, type, host_name, purpose, resident_company, floor, status, record_at)
         SELECT UUID(), 'PRE_REGISTRATION', pr.id, t.location_id, pr.name, pr.phone, pr.email, pr.company, pr.job_title, pr.visitor_type, COALESCE(pr.host_name, ''), COALESCE(pr.purpose, ''), t.name, t.floor, pr.status, pr.expected_at
           FROM pre_registrations pr JOIN tenants t ON t.id = pr.tenant_id WHERE pr.id IN (${marks})`,
        ids,
      );
      await run(`DELETE FROM pre_registrations WHERE id IN (${marks})`, ids);
    });
    result.archivedPreRegistrations += ids.length;
    if (rows.length < BATCH) break;
  }

  // ── stage 1c: event registrations ──
  for (;;) {
    const rows = await query(
      `SELECT r.id FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE e.location_id = ? AND e.ends_at < ${age} LIMIT ${BATCH}`,
      [locationId, d],
    );
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(", ");
    await inTransaction(async (run) => {
      await run(
        `INSERT INTO old_records (id, source, original_id, location_id, name, phone, email, company, status, event_title, record_at)
         SELECT UUID(), 'EVENT_REGISTRATION', r.id, e.location_id, r.name, r.phone, r.email, r.company, r.status, e.title, e.ends_at
           FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.id IN (${marks})`,
        ids,
      );
      await run(`DELETE FROM event_registrations WHERE id IN (${marks})`, ids);
    });
    result.archivedEventRegistrations += ids.length;
    if (rows.length < BATCH) break;
  }

  // ── stage 2: old enough in the archive, so the personal details go ──
  for (;;) {
    const rows = await query(
      `SELECT id, photo_url, signature_url FROM old_records WHERE location_id = ? AND anonymized_at IS NULL AND record_at < ${age} LIMIT ${BATCH}`,
      [locationId, stage2],
    );
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    // files first: if the update fails the rows are found again next run (deleting a missing file is harmless)
    for (const r of rows) {
      if (r.photo_url) await deleteUpload(r.photo_url);
      if (r.signature_url) await deleteUpload(r.signature_url);
    }
    await query(
      `UPDATE old_records SET name = 'Deleted visitor', phone = NULL, email = NULL, company = '', job_title = NULL, notes = NULL,
              photo_url = NULL, signature_url = NULL, documents_signed = NULL, anonymized_at = NOW()
        WHERE id IN (${ids.map(() => "?").join(", ")})`,
      ids,
    );
    result.anonymized += ids.length;
    if (rows.length < BATCH) break;
  }
  return result;
}

/**
 * Runs all three steps for every location. Returns what it did, per location.
 * A MySQL named lock stops two servers (or a timer and a manual run) from working at the same moment: the second one returns { skipped: true }.
 */
export async function runMaintenance({ dryRun = false } = {}) {
  const conn = await pool.getConnection();
  try {
    const [[lock]] = await conn.query("SELECT GET_LOCK('vms_maintenance', 0) AS got");
    if (!lock.got) return { skipped: true, locations: [] };
    try {
      const locations = await query("SELECT id, name FROM locations");
      const report = [];
      for (const loc of locations) {
        const entry = { location: loc.name, autoCheckedOut: 0, overstayFlagged: 0, retention: null, error: null };
        try {
          const settings = await getSettings(loc.id);
          // a dry run only counts what the retention stages WOULD do and changes nothing
          if (!dryRun) {
            entry.autoCheckedOut = await autoCheckOut(loc.id, settings.autoCheckout);
            entry.overstayFlagged = await flagOverstays(loc.id, settings.overstayHours);
          }
          entry.retention = await applyRetention(loc.id, settings.retentionDays, { dryRun });
          const r = entry.retention;
          if (!dryRun && (r.archivedVisits || r.archivedPreRegistrations || r.archivedEventRegistrations || r.anonymized)) {
            await audit("DATA_RETENTION_RUN", "Security", SYSTEM(loc.id), { days: Number(settings.retentionDays), ...r });
          }
        } catch (err) {
          // one location failing must not stop the others
          entry.error = err.message;
          console.error(`Maintenance failed for ${loc.name}:`, err);
        }
        report.push(entry);
      }
      return { skipped: false, dryRun, locations: report };
    } finally {
      await conn.query("SELECT RELEASE_LOCK('vms_maintenance')");
    }
  } finally {
    conn.release();
  }
}

/** Starts the in-process timer (see server.js). Turn it off with JOBS_ENABLED=false when something else calls the job. */
export function startMaintenanceTimer() {
  if (process.env.JOBS_ENABLED === "false") return;
  const minutes = Math.max(1, Number(process.env.JOBS_INTERVAL_MINUTES) || 10);
  const run = () => runMaintenance().then((r) => r.locations.some((l) => l.autoCheckedOut || l.overstayFlagged) && console.log("Maintenance:", JSON.stringify(r))).catch((err) => console.error("Maintenance failed:", err));
  setTimeout(run, 30_000).unref();
  setInterval(run, minutes * 60_000).unref();
  console.log(`Maintenance job runs every ${minutes} minutes.`);
}
