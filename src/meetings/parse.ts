/**
 * Meeting discovery from the OWA calendar frame (Teams "new" calendar).
 * Events are elements with aria-labels like:
 *   "Title, 12:30 PM to 2:30 PM, Tuesday, August 18, 2026, By X, Busy, Recurring event"
 * Online meetings say "Microsoft Teams Meeting" in the label; in-progress ones
 * additionally expose a live "Join" button (aria-label "Join Teams meeting").
 */
import type { Frame } from "playwright";

export interface Meeting {
  title: string;
  start: Date;
  end: Date;
  online: boolean;
  joinableNow: boolean;
  /** which frame the element lives in — needed for clicking later */
  frame: Frame;
  /** element handle index for re-locating */
  selector: string;
}

const ARIA_RE =
  /^(.+?),\s*(\d{1,2}:\d{2}\s?(?:AM|PM))\s+to\s+(\d{1,2}:\d{2}\s?(?:AM|PM)),\s*([A-Za-z]+),\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/;

export async function parseCalendar(frame: Frame): Promise<Meeting[]> {
  const raw = await frame.evaluate(() => {
    const out: { aria: string; idx: number }[] = [];
    let idx = 0;
    for (const el of document.querySelectorAll("[aria-label]")) {
      const aria = el.getAttribute("aria-label") ?? "";
      if (/\d{1,2}:\d{2}\s?(AM|PM)\s+to\s+\d{1,2}:\d{2}\s?(AM|PM)/i.test(aria)) {
        out.push({ aria, idx });
      }
      idx++;
    }
    return out;
  });

  const meetings: Meeting[] = [];
  for (const r of raw) {
    const m = r.aria.match(ARIA_RE);
    if (!m) continue;
    const [, title, t1, t2, wd, mon, day, yr] = m;
    const start = new Date(`${mon} ${day}, ${yr} ${t1}`);
    const end = new Date(`${mon} ${day}, ${yr} ${t2}`);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
    const online = /Microsoft Teams Meeting/i.test(r.aria) || /Teams meeting/i.test(r.aria);
    meetings.push({
      title: title.trim(),
      start,
      end,
      online,
      joinableNow: false,
      frame,
      selector: `[aria-label="${r.aria.replace(/"/g, '\\"').slice(0, 200)}"]`,
    });
  }
  // dedupe by title+start (an event can appear twice: card + aria source)
  const seen = new Set<string>();
  return meetings.filter((mt) => {
    const k = `${mt.title}|${mt.start.getTime()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Mark meetings currently in progress (start <= now <= end) as joinableNow. */
export function markInProgress(meetings: Meeting[]): Meeting[] {
  const now = Date.now();
  return meetings.map((mt) => ({ ...mt, joinableNow: mt.start.getTime() <= now && now <= mt.end.getTime() }));
}
