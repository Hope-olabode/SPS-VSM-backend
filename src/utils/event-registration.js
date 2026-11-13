import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../db.js";
import { audit } from "./audit.js";
import { buildPhone, PHONE_CODES } from "./phone.js";

/** The secret in an event's registration link: 128 random bits as 32 hex characters */
export const newRegistrationToken = () => randomBytes(16).toString("hex");
export const isRegistrationToken = (value) => /^[a-f0-9]{32}$/.test(String(value));

const Register = z.object({
  firstName: z.string().trim().min(1, "Enter the attendee's first name").max(80),
  lastName: z.string().trim().min(1, "Enter the attendee's last name").max(80),
  email: z
    .string()
    .trim()
    .max(190)
    .default("")
    .refine((value) => value === "" || /^\S+@\S+\.\S+$/.test(value), "Enter a valid email address"),
  phoneCode: z.enum(PHONE_CODES).default("+234"),
  phone: z.string().trim().min(1, "Enter a phone number"),
  company: z.string().trim().max(160).default(""),
});

/** Checks the form and turns it into what registerAttendee wants: { attendee } or { error } */
export function readAttendee(body) {
  const parsed = Register.safeParse(body);
  if (!parsed.success) return { error: Object.values(parsed.error.flatten().fieldErrors).flat()[0] ?? "Some details are missing or invalid." };
  const d = parsed.data;

  const { phone, error } = buildPhone(d.phoneCode, d.phone);
  if (error) return { error };
  if (!phone) return { error: "Enter a phone number" };
  return { attendee: { name: `${d.firstName} ${d.lastName}`, email: d.email, phone, company: d.company } };
}

/**
 * Adds one attendee to an event. Shared by staff (events.js) and the public registration link (public-events.js).
 *
 *  - where, params: how to find the event, e.g. "id = ? AND location_id = ?" or "registration_token = ?"
 *  - attendee:      { name, email, phone, company }, with the phone already normalised
 *  - selfService:   true when the attendee registered themselves through the link. Then an event that requires host
 *                   approval saves them as PENDING; staff registrations are always APPROVED.
 *  - user:          who the audit trail names (the signed-in user; ignored for self-service)
 *
 * The event row is locked while we count, so two people can't both take the last place.
 * Returns { error: { status, message } } when it can't (404, or 409 when the event has ended, is full or the phone is already registered),
 * otherwise { row, status, registered, capacity, event }. Pending registrations hold a place until staff decide.
 */
export async function registerAttendee({ where, params, attendee, selfService = false, user = null }) {
  const id = randomUUID();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[event]] = await conn.execute(
      `SELECT id, title, location_id, capacity, require_approval, ends_at < NOW() AS ended FROM events WHERE ${where} FOR UPDATE`,
      params,
    );
    const refuse = async (status, message) => {
      await conn.rollback();
      return { error: { status, message } };
    };
    if (!event) return await refuse(404, "Event not found.");
    if (event.ended) return await refuse(409, "This event has already ended.");

    const [[{ taken }]] = await conn.execute("SELECT COUNT(*) AS taken FROM event_registrations WHERE event_id = ?", [event.id]);
    if (Number(taken) >= event.capacity) return await refuse(409, `This event is full (${event.capacity} of ${event.capacity} places taken).`);

    const [[twin]] = await conn.execute("SELECT id FROM event_registrations WHERE event_id = ? AND phone = ?", [event.id, attendee.phone]);
    if (twin) {
      return await refuse(409, selfService ? "This phone number is already registered for this event." : "Someone with that phone number is already registered for this event.");
    }

    const status = selfService && event.require_approval ? "PENDING" : "APPROVED";
    await conn.execute(
      "INSERT INTO event_registrations (id, event_id, name, email, phone, company, status, registered_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, event.id, attendee.name, attendee.email || null, attendee.phone, attendee.company, status, selfService ? null : user.id],
    );

    const run = async (sql, values) => (await conn.execute(sql, values))[0];
    if (selfService) {
      const actor = { name: "Registration link", locationId: event.location_id };
      await audit("EVENT_REGISTRATION_SELF", "Visitor", actor, { eventId: event.id, title: event.title, name: attendee.name, pending: status === "PENDING" }, run);
    } else {
      await audit("EVENT_REGISTRATION_ADDED", "Visitor", user, { eventId: event.id, title: event.title, name: attendee.name }, run);
    }
    await conn.commit();

    const [[row]] = await conn.execute("SELECT id, name, email, phone, company, status, created_at FROM event_registrations WHERE id = ?", [id]);
    return { row, status, registered: Number(taken) + 1, capacity: event.capacity, event };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
