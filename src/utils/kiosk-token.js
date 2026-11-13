import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { one, pool, query } from "../db.js";

// A kiosk token is a long random secret, like ek_9f2c... (24 random bytes = 192 bits).
// The kiosk finds its location by the SHA-256 of the token (kiosk_tokens.token_hash).
// A copy is also stored encrypted (kiosk_tokens.token_enc) so an admin can see the link again later.

export const newToken = () => `ek_${randomBytes(24).toString("hex")}`;
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

// Encryption key: KIOSK_TOKEN_KEY if set, otherwise JWT_SECRET. If you change it, existing links can no longer be shown
// (they keep working, an admin just has to regenerate to see a new one).
const key = () => createHash("sha256").update(process.env.KIOSK_TOKEN_KEY || process.env.JWT_SECRET || "").digest();

function encrypt(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
}

function decrypt(value) {
  try {
    const [iv, tag, data] = value.split(".").map((part) => Buffer.from(part, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** The address the kiosk tablet opens. The kiosk page lives on the frontend, so it uses CLIENT_ORIGIN. */
export const kioskUrl = (token) => `${(process.env.CLIENT_ORIGIN ?? "").replace(/\/$/, "")}/kiosk?token=${token}`;

/**
 * The location's current kiosk link. Creates the first one when there is none yet.
 * url is null when a link exists but can't be shown (the encryption key changed): regenerate to get a new one.
 */
export async function getKioskLink(locationId) {
  const row = await one("SELECT token_enc FROM kiosk_tokens WHERE location_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", [locationId]);
  if (!row) return { url: kioskUrl(await createToken(locationId)) };
  const token = row.token_enc ? decrypt(row.token_enc) : null;
  return { url: token ? kioskUrl(token) : null };
}

async function createToken(locationId) {
  const token = newToken();
  await query("INSERT INTO kiosk_tokens (id, location_id, token_hash, token_enc) VALUES (?, ?, ?, ?)", [randomUUID(), locationId, hashToken(token), encrypt(token)]);
  return token;
}

/** Turns the old link off and makes a new one. Both steps happen together or not at all. */
export async function regenerateKioskLink(locationId) {
  const token = newToken();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("UPDATE kiosk_tokens SET revoked_at = NOW() WHERE location_id = ? AND revoked_at IS NULL", [locationId]);
    await conn.execute("INSERT INTO kiosk_tokens (id, location_id, token_hash, token_enc) VALUES (?, ?, ?, ?)", [randomUUID(), locationId, hashToken(token), encrypt(token)]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { url: kioskUrl(token) };
}

// ----- the kiosk access code -----
// The link alone is not enough to use a kiosk: the tablet must also be given this 6-digit code (kiosk_access_codes).
// Admins can see every location's code, and regenerate it. The server only compares hashes; the encrypted copy is for showing it to admins.

const newCode = () => String(randomInt(100000, 1000000));
const hashCode = (locationId, code) => createHash("sha256").update(`${locationId}:${code}`).digest("hex");

async function writeCode(locationId, code, replace) {
  const values = [locationId, hashCode(locationId, code), encrypt(code)];
  if (replace) {
    await query(
      "INSERT INTO kiosk_access_codes (location_id, code_hash, code_enc) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), code_enc = VALUES(code_enc)",
      values,
    );
  } else {
    // two requests at once can't make two codes: the first one wins
    await query("INSERT IGNORE INTO kiosk_access_codes (location_id, code_hash, code_enc) VALUES (?, ?, ?)", values);
  }
}

/** The location's current code (made the first time it is asked for). null when it can't be shown any more: regenerate it. */
export async function getKioskCode(locationId) {
  await writeCode(locationId, newCode(), false);
  const row = await one("SELECT code_enc FROM kiosk_access_codes WHERE location_id = ?", [locationId]);
  return row?.code_enc ? decrypt(row.code_enc) : null;
}

/** Replaces the code. Tablets that were unlocked with the old one are locked again on their next request. */
export async function regenerateKioskCode(locationId) {
  const code = newCode();
  await writeCode(locationId, code, true);
  return code;
}

/** Is this the location's code? Compared as hashes, in constant time. */
export async function checkKioskCode(locationId, code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  await writeCode(locationId, newCode(), false); // a location always has a code, so there is always one for an admin to read out
  const row = await one("SELECT code_hash FROM kiosk_access_codes WHERE location_id = ?", [locationId]);
  if (!row) return false;
  const expected = Buffer.from(row.code_hash, "hex");
  const given = Buffer.from(hashCode(locationId, code), "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Every location with its code, for the admin's Locations page */
export async function listKioskCodes() {
  const locations = await query("SELECT id, name, active FROM locations ORDER BY is_primary DESC, created_at");
  return Promise.all(locations.map(async (l) => ({ locationId: l.id, name: l.name, active: Boolean(l.active), code: await getKioskCode(l.id) })));
}
