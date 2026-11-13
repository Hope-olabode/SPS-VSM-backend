// Reads ?from=yyyy-mm-dd&to=yyyy-mm-dd (both days included). The browser decides what "today" is and sends the dates.
const DAY = 24 * 60 * 60 * 1000;
const toMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(toMs(value)).toISOString().slice(0, 10) === value;

/** Returns { from, to, days } or { error } with a message that can be sent straight to the person */
export function parseRange({ from, to }, maxDays = 366) {
  if (!isDate(from) || !isDate(to)) return { error: "Send from and to as yyyy-mm-dd." };
  const days = (toMs(to) - toMs(from)) / DAY + 1;
  if (days < 1) return { error: "The start date can't be after the end date." };
  if (days > maxDays) return { error: "Choose a range of one year or less." };
  return { from, to, days };
}
