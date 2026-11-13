import { Router } from "express";
import { query } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../utils/audit.js";
import { getKioskCode, getKioskLink, regenerateKioskCode, regenerateKioskLink } from "../utils/kiosk-token.js";
import { DEFAULT_SETTINGS, getSettings, SETTING_LABELS, SettingsSchema } from "../utils/settings.js";

const router = Router();
router.use(requireAuth); // everyone signed in can read them (check-in and the Visitor Log follow them)

/** GET /api/settings — this location's settings */
router.get("/", async (req, res) => {
  res.json({ ok: true, settings: await getSettings(req.user.locationId) });
});

/** PUT /api/settings — admins only. Send the whole object; the audit trail records what changed. */
router.put("/", requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN"), async (req, res) => {
  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = Object.values(parsed.error.flatten().fieldErrors).flat()[0] ?? "Some settings are missing or invalid.";
    return res.status(400).json({ ok: false, error: message });
  }
  const next = parsed.data;

  const before = await getSettings(req.user.locationId);
  const changed = Object.keys(DEFAULT_SETTINGS).filter((key) => before[key] !== next[key]);
  if (changed.length === 0) return res.json({ ok: true, settings: before });

  await query(
    "INSERT INTO location_settings (location_id, settings) VALUES (?, ?) ON DUPLICATE KEY UPDATE settings = VALUES(settings)",
    [req.user.locationId, JSON.stringify(next)],
  );
  await audit("SETTINGS_UPDATED", "Security", req.user, { changed: changed.map((key) => SETTING_LABELS[key]) });
  res.json({ ok: true, settings: next });
});

/**
 * GET /api/settings/kiosk — this location's kiosk link (admins only: anyone with it can use the kiosk).
 * The first call creates it. url is null if it can't be shown any more, in which case regenerate it.
 */
router.get("/kiosk", requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN"), async (req, res) => {
  res.json({ ok: true, ...(await getKioskLink(req.user.locationId)), code: await getKioskCode(req.user.locationId) });
});

/** POST /api/settings/kiosk/regenerate — turns the old link off for good and returns a new one */
router.post("/kiosk/regenerate", requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN"), async (req, res) => {
  const link = await regenerateKioskLink(req.user.locationId);
  await audit("KIOSK_TOKEN_REGENERATED", "Security", req.user);
  res.json({ ok: true, ...link });
});

/** POST /api/settings/kiosk/code/regenerate — a new 6-digit kiosk code. Tablets unlocked with the old one ask for the new one. */
router.post("/kiosk/code/regenerate", requireRole("GLOBAL_ADMIN", "LOCATION_ADMIN"), async (req, res) => {
  const code = await regenerateKioskCode(req.user.locationId);
  await audit("KIOSK_CODE_REGENERATED", "Security", req.user);
  res.json({ ok: true, code });
});

export default router;
