/** 12-hour display helpers — the project standard for ALL clock times. */

/** "18:13" → "6:13 PM" (accepts undefined) */
export function t12(hhmm?: string): string {
  if (!hhmm) return "";
  const d = new Date(`2000-01-01T${hhmm.padStart(5, "0")}`);
  return isNaN(d.getTime())
    ? hhmm
    : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Date → "1:30 PM" */
export function clock(d: Date | string): string {
  return new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}
