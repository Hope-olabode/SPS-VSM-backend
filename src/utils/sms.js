// SMS helpers for the API. The same rules (and the same length counting) as frontend/src/lib/sms.ts, so the
// number of SMS the page shows is the number the server checks.

export const MAX_RECIPIENTS = 500;
/** Longer messages cost more, so a message may be at most this many SMS parts. */
export const MAX_SEGMENTS = 4;

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€"; // these take two characters' room

/** How many SMS parts a message will be billed as. One emoji or curly quote switches the whole message to Unicode. */
export function smsInfo(text) {
  if (!text) return { units: 0, segments: 0, encoding: "GSM-7" };

  let units = 0;
  let gsm = true;
  for (const char of text) {
    if (GSM_BASIC.includes(char)) units += 1;
    else if (GSM_EXTENDED.includes(char)) units += 2;
    else {
      gsm = false;
      break;
    }
  }

  if (gsm) return { units, segments: units <= 160 ? 1 : Math.ceil(units / 153), encoding: "GSM-7" };
  units = text.length;
  return { units, segments: units <= 70 ? 1 : Math.ceil(units / 67), encoding: "Unicode" };
}
