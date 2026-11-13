import { z } from "zod";
import { one } from "../db.js";

// The Control Panel settings. One JSON object per location (table location_settings).
// Keep this file in step with Settings in the frontend's lib/settings.ts.
export const DEFAULT_SETTINGS = {
  // check-in
  requirePhoto: true,
  requireSignature: true,
  requireHostApproval: false,
  allowWalkIns: true,
  // check-out
  requireCheckoutClearance: true,
  autoCheckout: "end_of_day",
  overstayHours: "4",
  // security & privacy
  screenWatchlist: true,
  maskPhones: true,
  retentionDays: "90",
  // notifications
  notifyHostOnArrival: true,
  notifyWatchlistMatch: true,
  notifyOverstay: true,
  dailySummary: false,
  // kiosk
  welcomeMessage: "Welcome! Please check in to let your host know you've arrived.",
};

/** Names shown in the audit trail when a setting changes */
export const SETTING_LABELS = {
  requirePhoto: "Photo capture",
  requireSignature: "Signature requirement",
  requireHostApproval: "Host approval",
  allowWalkIns: "Walk-ins",
  requireCheckoutClearance: "Checkout clearance",
  autoCheckout: "Auto check-out",
  overstayHours: "Overstay alert",
  screenWatchlist: "Watchlist screening",
  maskPhones: "Phone masking",
  retentionDays: "Data retention",
  notifyHostOnArrival: "Host arrival alerts",
  notifyWatchlistMatch: "Watchlist match alerts",
  notifyOverstay: "Overstay alerts",
  dailySummary: "Daily summary email",
  welcomeMessage: "Kiosk welcome message",
};

/** strictObject: a request with an unknown setting is refused instead of silently stored */
export const SettingsSchema = z.strictObject({
  requirePhoto: z.boolean(),
  requireSignature: z.boolean(),
  requireHostApproval: z.boolean(),
  allowWalkIns: z.boolean(),
  requireCheckoutClearance: z.boolean(),
  autoCheckout: z.enum(["never", "end_of_day", "8", "12"]),
  overstayHours: z.enum(["2", "4", "8", "12"]),
  screenWatchlist: z.boolean(),
  maskPhones: z.boolean(),
  retentionDays: z.enum(["30", "90", "180", "365"]),
  notifyHostOnArrival: z.boolean(),
  notifyWatchlistMatch: z.boolean(),
  notifyOverstay: z.boolean(),
  dailySummary: z.boolean(),
  welcomeMessage: z.string().trim().min(1, "Enter a welcome message").max(120, "The welcome message can be at most 120 characters"),
});

/**
 * The settings of one location: what was saved, on top of the defaults (so a setting added later
 * still has a value for locations that saved before it existed).
 */
export async function getSettings(locationId) {
  const row = await one("SELECT settings FROM location_settings WHERE location_id = ?", [locationId]);
  const stored = typeof row?.settings === "string" ? JSON.parse(row.settings) : (row?.settings ?? {});
  const known = Object.fromEntries(Object.entries(stored).filter(([key]) => key in DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...known };
}
