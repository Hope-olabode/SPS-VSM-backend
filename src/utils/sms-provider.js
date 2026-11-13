// Talks to the SMS provider. The keys live in backend/.env (see .env.example); without them every send is a harmless dry run.
//   SMS_PROVIDER=termii
//   TERMII_API_KEY=...
//   SMS_SENDER_ID=...          a sender ID registered with the provider (max 11 characters)
//   TERMII_BASE_URL=...        optional, defaults to https://api.ng.termii.com (use the one shown in your Termii dashboard)
//   TERMII_CHANNEL=...         optional, "generic" (default) or "dnd"
//
// To use a different provider (Africa's Talking, Twilio, ...) only deliver() below needs to change.

export const smsMode = () => (process.env.SMS_PROVIDER === "termii" && process.env.TERMII_API_KEY ? "live" : "dry-run");

const BULK_LIMIT = 100;

/** `recipients` are already validated +234 numbers. Resolves to { mode, accepted, failed, error? } */
export async function deliver(recipients, message) {
  if (smsMode() === "dry-run") {
    console.info(`[sms:dry-run] would send to ${recipients.length} recipient(s): ${JSON.stringify(message)}`);
    return { mode: "dry-run", accepted: recipients.length, failed: 0 };
  }

  const base = (process.env.TERMII_BASE_URL ?? "https://api.ng.termii.com").replace(/\/$/, "");
  let accepted = 0;
  let failed = 0;
  let error;

  for (let i = 0; i < recipients.length; i += BULK_LIMIT) {
    const batch = recipients.slice(i, i + BULK_LIMIT);
    try {
      const response = await fetch(`${base}/api/sms/send/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TERMII_API_KEY,
          to: batch.map((phone) => phone.replace("+", "")),
          from: process.env.SMS_SENDER_ID,
          sms: message,
          type: "plain",
          channel: process.env.TERMII_CHANNEL ?? "generic",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.code === "ok") accepted += batch.length;
      else {
        failed += batch.length;
        error ??= body.message ?? `The SMS provider answered with status ${response.status}`;
      }
    } catch {
      failed += batch.length;
      error ??= "Could not reach the SMS provider";
    }
  }

  return { mode: "live", accepted, failed, error };
}
