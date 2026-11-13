import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { canSee, subscribe, toNotification } from "../utils/notifications.js";

const router = Router();
router.use(requireAuth);

/** GET /api/notifications — the latest ones this user may see, newest first (what the bell shows when the page opens) */
router.get("/", async (req, res) => {
  const rows = await query("SELECT id, action, category, actor_id, actor_name, meta, created_at FROM audit_events WHERE location_id = ? ORDER BY id DESC LIMIT 60", [req.user.locationId]);
  const items = rows
    .filter((row) => canSee(req.user, { locationId: req.user.locationId, category: row.category, action: row.action }))
    .slice(0, 25)
    .map((row) => toNotification({ id: row.id, action: row.action, category: row.category, actorId: row.actor_id, actorName: row.actor_name, meta: row.meta, createdAt: row.created_at }));
  res.json({ ok: true, items });
});

/**
 * GET /api/notifications/stream — server-sent events: one message per new notification, for the signed-in user's location.
 * The browser (EventSource) reconnects by itself if the connection drops; a comment line every 25 seconds keeps proxies from closing it.
 */
router.get("/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 5000\n\n");

  const unsubscribe = subscribe({
    role: req.user.role,
    locationId: req.user.locationId,
    send: (notification) => res.write(`id: ${notification.id}\ndata: ${JSON.stringify(notification)}\n\n`),
  });
  const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

export default router;
