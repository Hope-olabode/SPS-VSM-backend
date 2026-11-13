import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { parseRange } from "../utils/date-range.js";

const router = Router();
router.use(requireAuth);

const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const titleCase = (value) => (value ? value[0] + value.slice(1).toLowerCase() : "");
const STATUS = { ONSITE: "onsite", PENDING_CLEARANCE: "pending_clearance", LEFT: "left" };
const DOCUMENT_TYPE = { NDA: "NDA", SAFETY_BRIEFING: "Safety Briefing", WIFI_POLICY: "Wi-Fi Policy", OTHER: "Other" };

/** Minutes between check-in and check-out (or now, for someone still inside), rounded like the dashboard does */
const MINUTES = "ROUND(TIMESTAMPDIFF(SECOND, v.check_in_at, COALESCE(v.check_out_at, NOW())) / 60)";

/** A list is cut off after this many rows; the report says so when that happens */
const LIST_LIMIT = 1000;
const cut = (rows) => ({ items: rows.slice(0, LIST_LIMIT), truncated: rows.length > LIST_LIMIT });

/**
 * The visits a report counts: admitted visitors (not waiting for approval, not turned away) who checked in on one of the
 * chosen days at the signed-in user's location, for one resident company when ?company= is a tenant id ("none" = visitors
 * without a resident company, missing or "all" = everyone).
 */
function scope(req, range) {
  const company = String(req.query.company ?? "all");
  let tenantSql = "";
  const tenantParams = [];
  if (company === "none") tenantSql = " AND v.tenant_id IS NULL";
  else if (company !== "all") {
    tenantSql = " AND v.tenant_id = ?";
    tenantParams.push(company.slice(0, 36));
  }
  return {
    sql: `v.status NOT IN ('PENDING_APPROVAL', 'DECLINED') AND v.location_id = ? AND v.check_in_at >= ? AND v.check_in_at < DATE_ADD(?, INTERVAL 1 DAY)${tenantSql}`,
    params: [req.user.locationId, range.from, range.to, ...tenantParams],
    /** just the company part, for queries that count something other than check-ins (the watchlist report's signatures) */
    tenantSql,
    tenantParams,
  };
}

const REPORTS = {
  /** Checked in, and nobody has recorded a check-out */
  async overstay(req, range) {
    const { sql, params } = scope(req, range);
    const rows = await query(
      `SELECT v.id, v.host_name, v.status, v.check_in_at, ${MINUTES} AS minutes,
              p.first_name, p.last_name, p.company, t.name AS resident_company, t.floor
         FROM visits v
         JOIN visitors p ON p.id = v.visitor_id
         LEFT JOIN tenants t ON t.id = v.tenant_id
        WHERE ${sql} AND v.status IN ('ONSITE', 'PENDING_CLEARANCE') AND v.check_out_at IS NULL
        ORDER BY v.check_in_at DESC
        LIMIT ${LIST_LIMIT + 1}`,
      params,
    );
    return cut(
      rows.map((r) => ({
        id: r.id,
        visitor: `${r.first_name} ${r.last_name}`,
        company: r.company,
        host: r.host_name,
        checkInAt: r.check_in_at,
        status: STATUS[r.status],
        durationMinutes: Number(r.minutes),
        residentCompany: r.resident_company ?? "Unassigned",
        suite: r.floor ?? "",
      })),
    );
  },

  /** Visitors and average stay per resident company */
  async occupancy(req, range) {
    const { sql, params } = scope(req, range);
    const rows = await query(
      `SELECT t.name AS company, t.floor, COUNT(*) AS n, AVG(${MINUTES}) AS avg_minutes
         FROM visits v LEFT JOIN tenants t ON t.id = v.tenant_id
        WHERE ${sql}
        GROUP BY v.tenant_id, t.name, t.floor
        ORDER BY n DESC, company`,
      params,
    );
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    return {
      items: rows.map((r) => ({
        company: r.company ?? "Unassigned",
        suite: r.floor ?? "",
        visitors: Number(r.n),
        avgMinutes: Math.round(Number(r.avg_minutes)),
        sharePct: percent(Number(r.n), total),
      })),
    };
  },

  /** Arrivals per hour of the day. Always 6 AM to 8 PM, stretched when someone arrived outside that. */
  async lobby(req, range) {
    const { sql, params } = scope(req, range);
    const rows = await query(`SELECT HOUR(v.check_in_at) AS h, COUNT(*) AS n FROM visits v WHERE ${sql} GROUP BY h`, params);
    const perHour = new Map(rows.map((r) => [Number(r.h), Number(r.n)]));
    const total = [...perHour.values()].reduce((sum, n) => sum + n, 0);
    const peak = Math.max(0, ...perHour.values());
    const first = Math.min(6, ...perHour.keys());
    const last = Math.max(19, ...perHour.keys());

    return {
      total,
      items: Array.from({ length: last - first + 1 }, (_, i) => {
        const hour = first + i;
        const checkIns = perHour.get(hour) ?? 0;
        const level = checkIns === 0 ? "Quiet" : checkIns === peak ? "Peak" : checkIns / total >= 0.1 ? "Moderate" : "Normal";
        return { hour, checkIns, sharePct: percent(checkIns, total), level };
      }),
    };
  },

  /** Visits and average stay per visitor type */
  async category(req, range) {
    const { sql, params } = scope(req, range);
    const rows = await query(
      `SELECT v.type AS category, COUNT(*) AS n, AVG(${MINUTES}) AS avg_minutes FROM visits v WHERE ${sql} GROUP BY v.type ORDER BY n DESC, category`,
      params,
    );
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    return {
      items: rows.map((r) => ({ category: r.category, visits: Number(r.n), avgMinutes: Math.round(Number(r.avg_minutes)), sharePct: percent(Number(r.n), total) })),
    };
  },

  /** Every visit in the range, newest first. ?limit= (default 500, at most 20000) cuts the list; `total` is always the full count. */
  async ledger(req, range) {
    const { sql, params } = scope(req, range);
    const limit = Math.min(20000, Math.max(1, Math.floor(Number(req.query.limit)) || 500));
    const [rows, [{ total }]] = await Promise.all([
      query(
        `SELECT v.id, v.type, v.host_name, v.status, v.check_in_at, v.check_out_at, ${MINUTES} AS minutes,
                p.first_name, p.last_name, p.company, t.name AS resident_company
           FROM visits v
           JOIN visitors p ON p.id = v.visitor_id
           LEFT JOIN tenants t ON t.id = v.tenant_id
          WHERE ${sql}
          ORDER BY v.check_in_at DESC, v.id
          LIMIT ${limit}`,
        params,
      ),
      query(`SELECT COUNT(*) AS total FROM visits v WHERE ${sql}`, params),
    ]);
    return {
      total: Number(total),
      items: rows.map((r) => ({
        id: r.id,
        visitor: `${r.first_name} ${r.last_name}`,
        type: r.type,
        company: r.company,
        host: r.host_name,
        residentCompany: r.resident_company ?? "Unassigned",
        checkInAt: r.check_in_at,
        checkOutAt: r.check_out_at,
        status: STATUS[r.status],
        durationMinutes: Number(r.minutes),
      })),
    };
  },

  /**
   * Four short lists: the whole current watchlist (it is shared by every location), then, for the chosen days at this
   * location: check-ins that were blocked by a watchlist match, NDA and other document signatures, and emergency mode history.
   * The resident company filter only applies to the signatures.
   */
  async watchlist(req, range) {
    const { tenantSql, tenantParams } = scope(req, range);
    const between = "a.location_id = ? AND a.created_at >= ? AND a.created_at < DATE_ADD(?, INTERVAL 1 DAY)";
    const betweenArgs = [req.user.locationId, range.from, range.to];

    const [entries, blocked, signatures, emergencies] = await Promise.all([
      query(
        `SELECT id, first_name, last_name, company, severity, reason, created_at FROM watchlist
          ORDER BY FIELD(severity, 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'), created_at DESC LIMIT ${LIST_LIMIT + 1}`,
      ),
      query(
        `SELECT a.id, a.created_at, JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.visitor')) AS visitor, JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.severity')) AS severity
           FROM audit_events a WHERE a.action = 'WATCHLIST_MATCH' AND ${between} ORDER BY a.id DESC LIMIT ${LIST_LIMIT + 1}`,
        betweenArgs,
      ),
      // the signature image itself is never selected: this report only says who signed what, and when
      query(
        `SELECT ds.id, ds.signed_at, d.title, d.type, p.first_name, p.last_name, t.name AS resident_company
           FROM document_signatures ds
           JOIN visits v ON v.id = ds.visit_id
           JOIN visitors p ON p.id = v.visitor_id
           JOIN documents d ON d.id = ds.document_id
           LEFT JOIN tenants t ON t.id = v.tenant_id
          WHERE v.location_id = ? AND ds.signed_at >= ? AND ds.signed_at < DATE_ADD(?, INTERVAL 1 DAY)
            ${tenantSql}
          ORDER BY ds.signed_at DESC LIMIT ${LIST_LIMIT + 1}`,
        [req.user.locationId, range.from, range.to, ...tenantParams],
      ),
      query(
        `SELECT a.id, a.action, a.actor_name, a.created_at, CAST(JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.count')) AS UNSIGNED) AS count
           FROM audit_events a WHERE a.action IN ('EMERGENCY_ACTIVATED', 'EMERGENCY_DEACTIVATED', 'EMERGENCY_EVACUATION') AND ${between}
          ORDER BY a.id DESC LIMIT ${LIST_LIMIT + 1}`,
        betweenArgs,
      ),
    ]);

    return {
      entries: cut(entries.map((r) => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, company: r.company, severity: titleCase(r.severity), reason: r.reason, createdAt: r.created_at }))),
      blocked: cut(blocked.map((r) => ({ id: String(r.id), visitor: r.visitor ?? "Unknown", severity: titleCase(r.severity) || "Unknown", at: r.created_at }))),
      signatures: cut(
        signatures.map((r) => ({ id: r.id, visitor: `${r.first_name} ${r.last_name}`, document: r.title, documentType: DOCUMENT_TYPE[r.type] ?? r.type, residentCompany: r.resident_company ?? "Unassigned", signedAt: r.signed_at })),
      ),
      emergencies: cut(
        emergencies.map((r) => ({
          id: String(r.id),
          event: { EMERGENCY_ACTIVATED: "Activated", EMERGENCY_DEACTIVATED: "Deactivated", EMERGENCY_EVACUATION: "Evacuation" }[r.action],
          actor: r.actor_name,
          // only an evacuation has a headcount
          checkedOut: r.count === null ? undefined : Number(r.count),
          at: r.created_at,
        })),
      ),
    };
  },
};

/** GET /api/reports/:type?from=2026-11-01&to=2026-11-13&company=all — type is overstay, occupancy, lobby, category, ledger or watchlist */
router.get("/:type", async (req, res) => {
  const report = Object.hasOwn(REPORTS, req.params.type) ? REPORTS[req.params.type] : null;
  if (!report) return res.status(404).json({ ok: false, error: "Unknown report." });

  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ ok: false, error: range.error });

  res.json({ ok: true, from: range.from, to: range.to, ...(await report(req, range)) });
});

export default router;
