/** "0801 234 5621" / "+234 801 234 5621" / "8012345621" -> "+2348012345621", or null if it isn't a Nigerian mobile number */
export function normalizeNigerianPhone(input) {
  let digits = String(input).replace(/[^\d]/g, "");
  if (digits.startsWith("234")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  return /^[789]\d{9}$/.test(digits) ? `+234${digits}` : null;
}

// the same country codes the frontend forms offer (frontend/src/lib/phone-codes.ts keeps the matching list with country names)
export const PHONE_CODES = [
  "+234", "+233", "+27", "+254", "+44", "+1",
  "+229", "+228", "+225", "+221", "+237", "+255", "+256", "+250", "+251", "+20", "+212",
  "+971", "+966", "+91", "+86", "+81", "+61", "+33", "+49", "+39", "+34", "+31", "+55", "+52",
];

/** "+234" + "0801 234 5678" -> { phone: "+2348012345678" }. Nigerian numbers are stored the same way check-in saves them, so matching works. */
export function buildPhone(code, input) {
  const digits = String(input).replace(/\D/g, "");
  if (!digits) return { phone: null };
  if (code === "+234") {
    const phone = normalizeNigerianPhone(digits);
    return phone ? { phone } : { error: "That Nigerian phone number isn't valid." };
  }
  const local = digits.replace(/^0+/, "");
  return local.length >= 6 && code.length - 1 + local.length <= 15 ? { phone: `${code}${local}` } : { error: "That phone number isn't valid." };
}

/**
 * One number, whichever way it arrives, as "+<country code><number>", or null if it isn't valid.
 *  - "+441234567890" or "+234 801 234 5678": already has its own country code, so `code` is ignored
 *  - "0801 234 5678" / "7911 123456": a local number, so `code` (default +234) says which country it is in
 */
export function resolvePhone(code, input) {
  const raw = String(input ?? "").trim();
  if (raw.startsWith("+")) {
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("234")) return normalizeNigerianPhone(digits);
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  return buildPhone(PHONE_CODES.includes(code) ? code : "+234", raw).phone ?? null;
}

/** "+2348012345678" -> { phoneCode: "+234", phone: "801 234 5678" }, the two pieces the frontend shows */
export function splitPhone(phone) {
  if (!phone) return { phoneCode: "+234", phone: "" };
  const code = [...PHONE_CODES].sort((a, b) => b.length - a.length).find((c) => phone.startsWith(c));
  const rest = code ? phone.slice(code.length) : phone.replace("+", "");
  const local = code === "+234" && rest.length === 10 ? `${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}` : rest;
  return { phoneCode: code ?? "+234", phone: local };
}

/** "+2348012345678" -> "+23480 ••• ••78" (what staff without permission to see full numbers get) */
export const maskPhone = (phone) => `${phone.slice(0, 6)} ••• ••${phone.slice(-2)}`;
