import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Photos and signatures are saved as files here, and the database keeps only the relative path
// (e.g. "photos/<visit id>.jpg"). They are NEVER served as public static files: the visitors
// routes send them only to signed-in staff at the visit's location.
export const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "uploads");

const TYPES = {
  png: { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  jpeg: { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
};

/**
 * Checks a data URL like "data:image/png;base64,...." and returns { buffer, ext }, or null when it
 * isn't a real image of an allowed type and size. The first bytes are checked too, so a file can't
 * just claim to be a PNG.
 */
export function parseImageDataUrl(dataUrl, { allowed, maxBytes }) {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl ?? "");
  if (!match || !allowed.includes(match[1])) return null;

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > maxBytes) return null;

  const { ext, magic } = TYPES[match[1]];
  if (!magic.every((byte, i) => buffer[i] === byte)) return null;
  return { buffer, ext };
}

/** saveUpload("photos", visitId, image) -> "photos/<visitId>.jpg" */
export async function saveUpload(folder, id, { buffer, ext }) {
  const relative = `${folder}/${id}.${ext}`;
  await mkdir(path.join(UPLOADS_DIR, folder), { recursive: true });
  await writeFile(path.join(UPLOADS_DIR, relative), buffer);
  return relative;
}

export async function deleteUpload(relative) {
  await unlink(path.join(UPLOADS_DIR, relative)).catch(() => {});
}

/** The full path of a stored file, or null if the value would point outside UPLOADS_DIR. */
export function resolveUpload(relative) {
  const full = path.resolve(UPLOADS_DIR, relative);
  return full.startsWith(UPLOADS_DIR + path.sep) ? full : null;
}

/** The most a signature image may weigh (the same limit for the check-in and the check-out signature) */
export const MAX_SIGNATURE_BYTES = 300_000;

/**
 * Validates a check-out signature (a PNG data URL from the signature pad) without saving it.
 * Returns the parsed image, or null when it isn't a real PNG of an allowed size.
 */
export const parseSignature = (dataUrl) => parseImageDataUrl(dataUrl, { allowed: ["png"], maxBytes: MAX_SIGNATURE_BYTES });

/** Saves a parsed check-out signature as "checkout-signatures/<visit id>.png" and returns that relative path. */
export const saveCheckoutSignature = (visitId, image) => saveUpload("checkout-signatures", visitId, image);
