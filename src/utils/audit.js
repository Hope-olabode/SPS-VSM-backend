import { query } from "../db.js";
import { publishAudit } from "./notifications.js";

/**
 * Add one row to the audit trail and return its id. Action names match AuditAction in the frontend's lib/audit.ts.
 * Pass `run` (a function like query) to write the row inside a transaction you already have open.
 */
export async function audit(action, category, user, meta = null, run = query) {
  const result = await run(
    "INSERT INTO audit_events (action, category, actor_id, actor_name, actor_role, location_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [action, category, user?.id ?? null, user?.name ?? "System", user?.role ?? null, user?.locationId ?? null, meta ? JSON.stringify(meta) : null],
  );
  // every audit event is also a notification for the people signed in at that location
  try {
    publishAudit({ id: result.insertId, action, category, user, meta });
  } catch (err) {
    console.error("Couldn't publish notification", err);
  }
  return result.insertId;
}
