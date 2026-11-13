import { describe } from "./audit-messages.js";

// Every audit event is also a notification. The audit trail is already written for each action (check-in, approvals, clearance, ...),
// so publishAudit() is called from audit() and the live listeners (GET /api/notifications/stream) get it straight away.
// Listeners live in this one process, like the rate limiter: with several servers, each only tells its own browsers.

const TITLES = {
  KIOSK_CHECK_IN: "Visitor Checked In",
  KIOSK_CHECKOUT_REQUESTED: "Pending Kiosk Checkout Clearance",
  KIOSK_APPROVAL_REQUESTED: "Visitor Awaiting Approval",
  VISITOR_APPROVED: "Visitor Approved",
  VISITOR_DECLINED: "Visitor Declined",
  VISITOR_CLEARANCE_APPROVED: "Checkout Approved",
  VISITOR_CLEARANCE_DECLINED: "Checkout Declined",
  VISITOR_SIGN_OUT: "Visitor Checked Out",
  VISITOR_CHECK_OUT: "Visitor Checked Out",
  VISITOR_AUTO_CHECK_OUT: "Visitor Checked Out",
  VISITOR_OVERSTAY: "Visitor Overstay",
  WATCHLIST_MATCH: "Watchlist Match",
  EMERGENCY_ACTIVATED: "Emergency Activated",
  EMERGENCY_DEACTIVATED: "Emergency Cleared",
  EMERGENCY_EVACUATION: "Emergency Evacuation",
};

// signing in is an audit event, but a pop-up for every login would only be noise
const MUTED = new Set(["USER_LOGIN"]);
const ADMINS = new Set(["GLOBAL_ADMIN", "LOCATION_ADMIN"]);

const humanize = (action) =>
  action
    .split("_")
    .map((word) => word[0] + word.slice(1).toLowerCase())
    .join(" ");

/** The shape the browser gets, for both the live stream and the recent list */
export function toNotification({ id, action, category, actorId, meta, actorName, createdAt }) {
  const body = describe({ action, actor_name: actorName, meta }).map((part) => part.text).join("").trim();
  return { id: String(id), action, category, title: TITLES[action] ?? humanize(action), body, actorId: actorId ?? undefined, createdAt: new Date(createdAt).toISOString() };
}

/** Who may be told about an event: Visitor events go to everyone signed in at that location, Security events only to admins */
export function canSee({ role, locationId }, { locationId: eventLocationId, category, action }) {
  if (MUTED.has(action)) return false;
  // an event with no location (a background job) is for global admins only
  if (eventLocationId ? eventLocationId !== locationId : role !== "GLOBAL_ADMIN") return false;
  return category === "Visitor" || ADMINS.has(role);
}

const listeners = new Set();

/** A browser connected to the stream. Returns the function that disconnects it. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishAudit({ id, action, category, user, meta }) {
  const event = { locationId: user?.locationId ?? null, category, action };
  const notification = toNotification({ id, action, category, actorId: user?.id, actorName: user?.name ?? "System", meta, createdAt: Date.now() });
  for (const listener of listeners) {
    if (canSee(listener, event)) listener.send(notification);
  }
}
