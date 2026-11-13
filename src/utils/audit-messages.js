// Turns a stored audit row into the sentence the Audit Trail page shows.
// Segments with strong: true are shown in bold. Action names match AuditAction in the frontend's lib/audit.ts.
const p = (text) => ({ text });
const b = (text) => ({ text, strong: true });
const titleCase = (value) => (value ? value[0] + value.slice(1).toLowerCase() : "");

export function describe({ action, actor_name: actor, meta, location_name: location }) {
  const m = (typeof meta === "string" ? JSON.parse(meta) : meta) ?? {};

  switch (action) {
    case "KIOSK_CHECK_IN":
      return [p("Visitor "), b(m.visitor ?? "Unknown"), p(` checked in via kiosk${location ? ` (Location: ${location})` : ""}`)];
    case "KIOSK_CHECKOUT_REQUESTED":
      return [p("Visitor "), b(m.visitor ?? "Unknown"), p(` requested checkout at kiosk ${m.kiosk ?? "kiosk"}. Awaiting staff clearance.`)];
    case "KIOSK_APPROVAL_REQUESTED":
      return [p("Visitor "), b(m.visitor ?? "Unknown"), p(` is waiting for host approval at the kiosk${m.host ? ` (Host: ${m.host})` : ""}${location ? ` (Location: ${location})` : ""}.`)];
    case "VISITOR_APPROVED":
      return [p("Staff "), b(actor), p(" approved entry for visitor "), b(m.visitor ?? "Unknown"), p(".")];
    case "VISITOR_DECLINED":
      return [p("Staff "), b(actor), p(" declined entry for visitor "), b(m.visitor ?? "Unknown"), p(".")];
    case "VISITOR_CLEARANCE_APPROVED":
      return [p("Staff "), b(actor), p(" approved checkout clearance for visitor "), b(m.visitor ?? "Unknown"), p(".")];
    case "VISITOR_CLEARANCE_DECLINED":
      return [p("Staff "), b(actor), p(" declined checkout clearance for visitor "), b(m.visitor ?? "Unknown"), p(".")];
    case "VISITOR_SIGN_OUT":
      return [p("Staff "), b(actor), p(" signed out visitor "), b(m.visitor ?? "Unknown"), p(".")];
    case "VISITOR_CHECK_OUT":
      return [p("Visitor "), b(m.visitor ?? "Unknown"), p(" checked out.")];
    case "VISITOR_AUTO_CHECK_OUT":
      return [p("Visitor "), b(m.visitor ?? "Unknown"), p(" was checked out automatically"), p(m.rule === "end_of_day" ? " at the end of the day." : m.rule ? ` after ${m.rule} hours.` : ".")];
    case "VISITOR_OVERSTAY":
      return [p("Visitor "), b(m.visitor ?? "Unknown"), p(` has been onsite for more than ${m.hours ?? "the allowed number of"} hours${m.host ? ` (Host: ${m.host})` : ""}.`)];
    case "DATA_RETENTION_RUN": {
      const n = (k) => Number(m[k] ?? 0);
      return [
        p("Data retention moved "),
        b(`${n("archivedVisits")} visits, ${n("archivedPreRegistrations")} pre-registrations and ${n("archivedEventRegistrations")} event registrations`),
        p(` older than ${m.days ?? "the retention period"} days to old records, and removed the personal details from `),
        b(`${n("anonymized")} older archived records`),
        p("."),
      ];
    }
    case "WATCHLIST_MATCH":
      return [p("Check-in blocked for "), b(m.visitor ?? "a visitor"), p(` because of a watchlist match (severity: ${titleCase(m.severity) || "unknown"}).`)];
    case "WATCHLIST_ADDED":
      return [p("Staff "), b(actor), p(" added "), b(m.name ?? "someone"), p(` to the watchlist (severity: ${m.severity ?? "unknown"}).`)];
    case "WATCHLIST_REMOVED":
      return [p("Staff "), b(actor), p(" removed "), b(m.name ?? "someone"), p(" from the watchlist.")];
    case "PRE_REGISTRATION_CREATED":
      return [p("Staff "), b(actor), p(" pre-registered visitor "), b(m.visitor ?? "someone"), p(" for "), b(m.residentCompany ?? "a resident company"), p(".")];
    case "PRE_REGISTRATION_DELETED":
      return [p("Staff "), b(actor), p(" deleted the pre-registration of "), b(m.visitor ?? "someone"), p(" for "), b(m.residentCompany ?? "a resident company"), p(".")];
    case "EVENT_CREATED":
      return [p("Staff "), b(actor), p(" created event "), b(m.title ?? "an event"), p(".")];
    case "EVENT_DELETED":
      return [p("Staff "), b(actor), p(" deleted event "), b(m.title ?? "an event"), p(".")];
    case "EVENT_UPDATED":
      return [p("Staff "), b(actor), p(" updated event "), b(m.title ?? "an event"), p(".")];
    case "EVENT_LINK_REGENERATED":
      return [p("Staff "), b(actor), p(" regenerated the registration link of event "), b(m.title ?? "an event"), p(". The old link no longer works.")];
    case "EVENT_REGISTRATION_SELF":
      return [b(m.name ?? "Someone"), p(" registered for event "), b(m.title ?? "an event"), p(m.pending ? " through its link and is waiting for approval." : " through its link.")];
    case "EVENT_REGISTRATION_APPROVED":
      return [p("Staff "), b(actor), p(" approved the registration of "), b(m.name ?? "someone"), p(" for event "), b(m.title ?? "an event"), p(".")];
    case "EVENT_REGISTRATION_DECLINED":
      return [p("Staff "), b(actor), p(" declined the registration of "), b(m.name ?? "someone"), p(" for event "), b(m.title ?? "an event"), p(".")];
    case "EVENT_REGISTRATION_ADDED":
      return [p("Staff "), b(actor), p(" registered "), b(m.name ?? "someone"), p(" for event "), b(m.title ?? "an event"), p(".")];
    case "EVENT_REGISTRATION_REMOVED":
      return [p("Staff "), b(actor), p(" removed the registration of "), b(m.name ?? "someone"), p(" for event "), b(m.title ?? "an event"), p(".")];
    case "DOCUMENT_CREATED":
      return [p("Staff "), b(actor), p(" created document "), b(m.title ?? "a document"), p(".")];
    case "DOCUMENT_UPDATED":
      return [p("Staff "), b(actor), p(m.active ? " activated document " : " deactivated document "), b(m.title ?? "a document"), p(".")];
    case "DOCUMENT_REMOVED":
      return [p("Staff "), b(actor), p(" removed document "), b(m.title ?? "a document"), p(".")];
    case "SMS_CAMPAIGN_SENT": {
      const n = Number(m.count ?? 0);
      return [p("Staff "), b(actor), p(" sent an SMS campaign to "), b(`${n} ${n === 1 ? "recipient" : "recipients"}`), p(m.testMode ? " (test mode, nothing was delivered)." : ".")];
    }
    case "USER_INVITED":
      return [p("Staff "), b(actor), p(" invited user "), b(m.user ?? "someone"), p(".")];
    case "USER_UPDATED":
      return [p("Staff "), b(actor), p(" updated user "), b(m.user ?? "someone"), p(".")];
    case "USER_ROLE_CHANGED":
      return [p("Staff "), b(actor), p(" changed the role of "), b(m.user ?? "someone"), p(" to "), b(m.role ?? "a new role"), p(".")];
    case "USER_PASSWORD_RESET":
      return [p("Staff "), b(actor), p(" reset the password of user "), b(m.user ?? "someone"), p(".")];
    case "USER_REMOVED":
      return [p("Staff "), b(actor), p(" removed user "), b(m.user ?? "someone"), p(".")];
    case "RESIDENT_COMPANY_ADDED":
      return [p("Staff "), b(actor), p(" added resident company "), b(m.name ?? "a company"), p(".")];
    case "RESIDENT_COMPANY_UPDATED":
      return [p("Staff "), b(actor), p(" updated resident company "), b(m.name ?? "a company"), p(".")];
    case "RESIDENT_COMPANY_REMOVED":
      return [p("Staff "), b(actor), p(" removed resident company "), b(m.name ?? "a company"), p(".")];
    case "LOCATION_CREATED":
      return [p("Staff "), b(actor), p(" created location "), b(m.name ?? "a location"), p(".")];
    case "LOCATION_UPDATED":
      return [p("Staff "), b(actor), p(" updated location "), b(m.name ?? "a location"), p(".")];
    case "LOCATION_REMOVED":
      return [p("Staff "), b(actor), p(" removed location "), b(m.name ?? "a location"), p(".")];
    case "PROFILE_UPDATED":
      return [b(actor), p(" updated their profile.")];
    case "PASSWORD_CHANGED":
      return [b(actor), p(" changed their password.")];
    case "USER_LOGIN":
      return [b(actor), p(" signed in.")];
    case "SETTINGS_UPDATED": {
      const changed = Array.isArray(m.changed) ? m.changed : [];
      return [p("Staff "), b(actor), p(` updated ${changed.length === 1 ? "a setting" : `${changed.length} settings`}: `), b(changed.join(", ") || "none"), p(".")];
    }
    case "KIOSK_TOKEN_REGENERATED":
      return [p("Staff "), b(actor), p(" regenerated the branch kiosk URL. The old link no longer works.")];
    case "KIOSK_CODE_REGENERATED":
      return [p("Staff "), b(actor), p(` regenerated the kiosk code${m.location ? ` for ${m.location}` : ""}. Tablets using the old code must enter the new one.`)];
    case "KIOSK_UNLOCK_FAILED":
      return [p("Someone entered a wrong kiosk code at the "), b(m.kiosk ?? "kiosk"), p(" tablet.")];
    case "REPORTS_VIEW":
      return [p("Generated executive report (Type: "), b(m.type ?? "Report"), p(")")];
    case "PII_UNLOCKED":
      return [p("Staff "), b(actor), p(" revealed unmasked visitor phone numbers in the Visitor Log.")];
    case "EMERGENCY_ACTIVATED":
      return [p("Staff "), b(actor), p(" activated emergency mode.")];
    case "EMERGENCY_DEACTIVATED":
      return [p("Staff "), b(actor), p(" deactivated emergency mode.")];
    case "EMERGENCY_EVACUATION": {
      const n = Number(m.count ?? 0);
      return [p("Staff "), b(actor), p(" ran an emergency evacuation and checked out "), b(`${n} onsite ${n === 1 ? "visitor" : "visitors"}`), p(".")];
    }
    default:
      return [b(actor), p(` performed ${action}.`)];
  }
}
