import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, pool, query } from "../db.js";
import { audit } from "./audit.js";
import { PHONE_CODES, resolvePhone } from "./phone.js";
import { deleteUpload, parseImageDataUrl, saveUpload } from "./uploads.js";

// The check-in itself, shared by the staff screen (POST /api/visitors) and the kiosk (POST /api/kiosk/check-in).

export const CheckIn = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  /** the country code the number was typed with (a number that already starts with + keeps its own) */
  phoneCode: z.enum(PHONE_CODES).default("+234"),
  phone: z.string().trim().min(1),
  company: z.string().trim().default(""),
  visitorType: z.enum(["Guest", "Contractor", "Vendor", "Interviewee", "Client", "Candidate"]).default("Guest"),
  tenantId: z.string().optional(),
  /** the frontend form sends the resident company's name; used when tenantId isn't given */
  residentCompany: z.string().trim().default(""),
  hostName: z.string().trim().default(""),
  purpose: z.string().trim().default(""),
  notes: z.string().trim().default(""),
  /** JPEG/PNG data URLs from the camera step and the signature pad (both optional) */
  photo: z.string().optional(),
  signature: z.string().optional(),
  /** staff scanned a visitor's pass: the pre-registration this check-in is for (ignored at the kiosk) */
  preRegistrationId: z.string().trim().max(64).optional(),
});

const MAX_PHOTO_BYTES = 1_000_000;
const MAX_SIGNATURE_BYTES = 300_000;

const refuse = (status, error, extra = {}) => ({ status, body: { ok: false, error, ...extra } });

/**
 * Checks the visitor in at one location. Returns { status, body } for the route to send.
 *  - data:      the validated body (CheckIn schema)
 *  - locationId the location the visitor is arriving at
 *  - actor:     who the audit trail names (the signed-in user, or { name: "Kiosk", locationId })
 *  - settings:  that location's Control Panel settings
 *  - kiosk:     true when the visitor is checking themselves in (the "Allow walk-ins" and "Require host approval" settings only apply there)
 *  - passVerified: the kiosk already found data.preRegistrationId from a visitor's QR pass (today, this location, still waiting), so it counts as expected
 *
 * With "Require host approval" on, a kiosk visitor who was not pre-registered for today is saved as PENDING_APPROVAL
 * and staff let them in (or turn them away) from the Overview or Visitor Log. A pre-registered visitor was already
 * approved by whoever registered them, so they are checked in straight away.
 */
export async function performCheckIn({ data: d, locationId, actor, settings, kiosk = false, passVerified = false }) {
  const phone = resolvePhone(d.phoneCode, d.phone);
  if (!phone) return refuse(400, "That phone number isn't valid.");

  // was this visitor pre-registered for today at this location? (only matters at the kiosk)
  const expected = passVerified
    ? { id: d.preRegistrationId }
    : kiosk
      ? await one(
          "SELECT p.id FROM pre_registrations p JOIN tenants t ON t.id = p.tenant_id WHERE p.phone = ? AND p.status = 'EXPECTED' AND t.location_id = ? AND DATE(p.expected_at) = CURDATE() LIMIT 1",
          [phone, locationId],
        )
      : null;

  // with walk-ins off, a kiosk visitor must have been pre-registered
  if (kiosk && !settings.allowWalkIns && !expected) {
    return refuse(403, "Walk-ins aren't accepted here. Only visitors who were pre-registered for today can check in. Please see the front desk.");
  }
  const needsApproval = kiosk && settings.requireHostApproval && !expected;

  // at the kiosk the visitor can skip the photo (the Skip button on the photo step); staff check-ins still follow "Require photo"
  if (settings.requirePhoto && !kiosk && !d.photo) return refuse(400, "A photo of the visitor is required.");
  if (settings.requireSignature && !d.signature) return refuse(400, "The visitor must sign before checking in.");

  // photo and signature must be real, small images (checked before anything is saved)
  let photo = null;
  let signature = null;
  if (d.photo) {
    photo = parseImageDataUrl(d.photo, { allowed: ["jpeg", "png"], maxBytes: MAX_PHOTO_BYTES });
    if (!photo) return refuse(400, "The photo isn't a valid image, or it is too large.");
  }
  if (d.signature) {
    signature = parseImageDataUrl(d.signature, { allowed: ["png"], maxBytes: MAX_SIGNATURE_BYTES });
    if (!signature) return refuse(400, "The signature isn't a valid image, or it is too large.");
  }

  // watchlist screen (can be switched off in the Control Panel)
  const hit = settings.screenWatchlist ? await one("SELECT severity FROM watchlist WHERE phone = ? LIMIT 1", [phone]) : null;
  if (hit) {
    await audit("WATCHLIST_MATCH", "Security", actor, { visitor: `${d.firstName} ${d.lastName}`, severity: hit.severity });
    return refuse(403, "This visitor can't be checked in. Please contact security.");
  }

  // the resident company must exist at this location (by id, or by the name the form sends)
  let tenantId = null;
  if (d.tenantId || d.residentCompany) {
    const tenant = d.tenantId
      ? await one("SELECT id FROM tenants WHERE id = ? AND location_id = ?", [d.tenantId, locationId])
      : await one("SELECT id FROM tenants WHERE name = ? AND location_id = ?", [d.residentCompany, locationId]);
    if (!tenant) return refuse(400, "Choose a resident company from the list.");
    tenantId = tenant.id;
  }

  // a pass scanned by staff: it must still be waiting at this location (so one pass can't check in twice)
  let preRegistration = null;
  if (d.preRegistrationId && (!kiosk || passVerified)) {
    preRegistration = await one(
      "SELECT p.id FROM pre_registrations p JOIN tenants t ON t.id = p.tenant_id WHERE p.id = ? AND p.status = 'EXPECTED' AND t.location_id = ?",
      [d.preRegistrationId, locationId],
    );
    if (!preRegistration) return refuse(409, "This pass was already used or cancelled. Refresh the pre-registrations and try again.");
  }

  // the visitor row and the visit row are saved together or not at all
  const written = []; // files saved so far, deleted again if the database part fails
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let [[person]] = await conn.execute("SELECT id FROM visitors WHERE phone = ?", [phone]);
    if (person) {
      await conn.execute("UPDATE visitors SET first_name = ?, last_name = ?, company = ? WHERE id = ?", [d.firstName, d.lastName, d.company, person.id]);
    } else {
      person = { id: randomUUID() };
      await conn.execute("INSERT INTO visitors (id, first_name, last_name, phone, company) VALUES (?, ?, ?, ?, ?)", [person.id, d.firstName, d.lastName, phone, d.company]);
    }

    const visitId = randomUUID();
    const photoPath = photo ? await saveUpload("photos", visitId, photo) : null;
    if (photoPath) written.push(photoPath);
    const signaturePath = signature ? await saveUpload("signatures", visitId, signature) : null;
    if (signaturePath) written.push(signaturePath);

    await conn.execute(
      "INSERT INTO visits (id, visitor_id, location_id, tenant_id, host_name, type, purpose, notes, photo_url, signature_url, status, pre_registration_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [visitId, person.id, locationId, tenantId, d.hostName, d.visitorType, d.purpose, d.notes, photoPath, signaturePath, needsApproval ? "PENDING_APPROVAL" : "ONSITE", preRegistration?.id ?? null],
    );

    // the visitor signed every active document that asks for a signature (the check-in screen shows them)
    if (signature) {
      const [docs] = await conn.execute("SELECT id FROM documents WHERE active = 1 AND require_signature = 1");
      for (const doc of docs) {
        await conn.execute("INSERT INTO document_signatures (id, visit_id, document_id, signature_image) VALUES (?, ?, ?, ?)", [randomUUID(), visitId, doc.id, d.signature]);
      }
    }
    await conn.commit();

    // the scanned pass is used up. A pass saved without a phone number learns it now, so checking out finds it again.
    if (preRegistration) {
      await query("UPDATE pre_registrations SET status = 'CHECKED_IN', phone = COALESCE(phone, ?) WHERE id = ? AND status = 'EXPECTED'", [phone, preRegistration.id]);
    }

    // someone who was pre-registered for today has now arrived
    await query(
      "UPDATE pre_registrations p JOIN tenants t ON t.id = p.tenant_id SET p.status = 'CHECKED_IN' WHERE p.phone = ? AND p.status = 'EXPECTED' AND t.location_id = ? AND DATE(p.expected_at) = CURDATE()",
      [phone, locationId],
    );

    const visitor = `${d.firstName} ${d.lastName}`;
    if (needsApproval) {
      await audit("KIOSK_APPROVAL_REQUESTED", "Visitor", actor, { visitId, visitor, host: d.hostName });
      return { status: 201, body: { ok: true, id: visitId, status: "pending_approval" } };
    }
    await audit("KIOSK_CHECK_IN", "Visitor", actor, { visitId, visitor });
    return { status: 201, body: { ok: true, id: visitId, status: "checked_in" } };
  } catch (err) {
    await conn.rollback();
    await Promise.all(written.map(deleteUpload));
    throw err;
  } finally {
    conn.release();
  }
}
