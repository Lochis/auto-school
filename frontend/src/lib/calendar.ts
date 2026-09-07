/** Parse the backend's calendar scan dump (out/calendar-events.txt):
 *  one event per line: `startISO | endISO | online | joinableNow | title`
 *  Written on every calendar scan; mtime = scan freshness.
 *  Pure helpers (evState/stripPos) live in calendar-shared.ts for the client. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./data";
import type { CalEvent } from "./calendar-shared";

export { evState, stripPos } from "./calendar-shared";
export type { CalEvent } from "./calendar-shared";

export function readCalendar(): { events: CalEvent[]; asOf: Date | null } {
  const file = join(DATA_DIR, "out", "calendar-events.txt");
  if (!existsSync(file)) return { events: [], asOf: null };
  try {
    const events = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes(" | "))
      .map((l): CalEvent | null => {
        const [s, e, on, jb, ...rest] = l.split(" | ");
        const title = rest.join(" | ").trim();
        const start = new Date(s), end = new Date(e);
        if (isNaN(start.getTime()) || isNaN(end.getTime()) || !title) return null;
        return { start, end, online: on === "1", joinable: jb === "1", title };
      })
      .filter((x): x is CalEvent => x !== null)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return { events, asOf: statSync(file).mtime };
  } catch {
    return { events: [], asOf: null };
  }
}
