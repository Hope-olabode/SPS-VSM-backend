import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const DAY = 24 * 60 * 60 * 1000;
const toMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && toIso(toMs(value)) === value;
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // MySQL WEEKDAY() counts Monday as 0

/**
 * GET /api/analytics?from=2026-11-01&to=2026-11-13
 * Everything the Analytics page shows for the signed-in user's location, counted by check-in date (both dates included).
 * The browser decides what "today" is and sends the dates, so the page and the numbers always agree.
 */
router.get("/", async (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to)) return res.status(400).json({ ok: false, error: "Send from and to as yyyy-mm-dd." });
  const days = (toMs(to) - toMs(from)) / DAY + 1;
  if (days < 1) return res.status(400).json({ ok: false, error: "The start date can't be after the end date." });
  if (days > 366) return res.status(400).json({ ok: false, error: "Choose a range of one year or less." });

  // the period right before this one, for the "change" figure
  const prevTo = toIso(toMs(from) - DAY);
  const prevFrom = toIso(toMs(from) - days * DAY);

  const inRange = "v.status NOT IN ('PENDING_APPROVAL', 'DECLINED') AND v.location_id = ? AND v.check_in_at >= ? AND v.check_in_at < DATE_ADD(?, INTERVAL 1 DAY)";
  const args = [req.user.locationId, from, to];

  const [[summary], [returning], [previous], hourly, daily, byType, byWeekday, byPurpose, topVisitors, topHosts, topCompanies] = await Promise.all([
    query(
      `SELECT COUNT(*) AS total,
              AVG(TIMESTAMPDIFF(MINUTE, v.check_in_at, v.check_out_at)) AS avg_minutes,
              COALESCE(SUM(v.check_in_at < CURDATE()), 0) AS past,
              COALESCE(SUM(v.check_in_at < CURDATE() AND v.check_out_at IS NOT NULL), 0) AS past_out
         FROM visits v WHERE ${inRange}`,
      args,
    ),
    query(`SELECT COUNT(*) AS n FROM visits v WHERE ${inRange} AND EXISTS (SELECT 1 FROM visits o WHERE o.visitor_id = v.visitor_id AND o.check_in_at < v.check_in_at)`, args),
    query("SELECT COUNT(*) AS n FROM visits v WHERE v.status NOT IN ('PENDING_APPROVAL', 'DECLINED') AND v.location_id = ? AND v.check_in_at >= ? AND v.check_in_at < DATE_ADD(?, INTERVAL 1 DAY)", [req.user.locationId, prevFrom, prevTo]),
    query(`SELECT HOUR(v.check_in_at) AS h, COUNT(*) AS n FROM visits v WHERE ${inRange} GROUP BY h`, args),
    query(`SELECT DATE_FORMAT(v.check_in_at, '%Y-%m-%d') AS d, COUNT(*) AS n FROM visits v WHERE ${inRange} GROUP BY d`, args),
    query(`SELECT v.type AS name, COUNT(*) AS n FROM visits v WHERE ${inRange} GROUP BY v.type ORDER BY n DESC`, args),
    query(`SELECT WEEKDAY(v.check_in_at) AS w, COUNT(*) AS n FROM visits v WHERE ${inRange} GROUP BY w`, args),
    query(`SELECT CASE WHEN v.purpose = '' THEN 'Not specified' ELSE v.purpose END AS label, COUNT(*) AS n FROM visits v WHERE ${inRange} GROUP BY label ORDER BY n DESC LIMIT 8`, args),
    query(
      `SELECT CONCAT(p.first_name, ' ', p.last_name) AS name, p.company, COUNT(*) AS n
         FROM visits v JOIN visitors p ON p.id = v.visitor_id WHERE ${inRange}
        GROUP BY v.visitor_id, p.first_name, p.last_name, p.company ORDER BY n DESC, name LIMIT 6`,
      args,
    ),
    query(`SELECT v.host_name AS name, COUNT(*) AS n FROM visits v WHERE ${inRange} AND v.host_name <> '' GROUP BY v.host_name ORDER BY n DESC LIMIT 6`, args),
    query(
      `SELECT p.company AS name, COUNT(*) AS n FROM visits v JOIN visitors p ON p.id = v.visitor_id
        WHERE ${inRange} AND p.company <> '' AND LOWER(p.company) NOT IN ('n/a', 'na', 'none', 'self')
        GROUP BY p.company ORDER BY n DESC LIMIT 6`,
      args,
    ),
  ]);

  const total = Number(summary.total);

  // arrivals by hour, always showing at least 8:00 to 18:00 so quiet days still look like a day
  const perHour = new Map(hourly.map((row) => [Number(row.h), Number(row.n)]));
  const hours = [...perHour.keys()];
  const first = Math.min(8, ...hours);
  const last = Math.max(18, ...hours);
  const peakHours = Array.from({ length: last - first + 1 }, (_, i) => ({ hour: `${first + i}:00`, count: perHour.get(first + i) ?? 0 }));

  // one day -> the trend is hour by hour; longer -> day by day with the empty days included
  const perDay = new Map(daily.map((row) => [row.d, Number(row.n)]));
  const trend =
    days === 1
      ? peakHours.map((point) => ({ label: point.hour, count: point.count }))
      : Array.from({ length: days }, (_, i) => {
          const date = toIso(toMs(from) + i * DAY);
          return { label: date.slice(5), count: perDay.get(date) ?? 0 };
        });

  const perWeekday = new Map(byWeekday.map((row) => [Number(row.w), Number(row.n)]));
  const past = Number(summary.past);
  const previousTotal = Number(previous.n);

  res.json({
    ok: true,
    from,
    to,
    days,
    total,
    avgDurationMinutes: summary.avg_minutes === null ? null : Math.round(Number(summary.avg_minutes)),
    // share of visits made by someone who had visited before
    returnRate: percent(Number(returning.n), total),
    // share of visits from before today that were checked out (today's visitors may still be inside)
    compliance: past ? percent(Number(summary.past_out), past) : null,
    change: previousTotal ? Math.round(((total - previousTotal) / previousTotal) * 100) : null,
    trend,
    byType: byType.map((row) => ({ name: row.name, value: Number(row.n) })),
    peakHours,
    busiestDays: WEEKDAYS.map((day, index) => ({ day, count: perWeekday.get(index) ?? 0 })),
    byPurpose: byPurpose.map((row) => ({ label: row.label, count: Number(row.n) })),
    topVisitors: topVisitors.map((row) => ({ name: row.name, company: row.company || undefined, visits: Number(row.n) })),
    topHosts: topHosts.map((row) => ({ name: row.name, visits: Number(row.n) })),
    topCompanies: topCompanies.map((row) => ({ name: row.name, visits: Number(row.n) })),
  });
});

export default router;
