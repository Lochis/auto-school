/**
 * Meeting discovery from the OWA calendar frame (Teams "new" calendar).
 * Events are elements with aria-labels like:
 *   "Title, 12:30 PM to 2:30 PM, Tuesday, August 18, 2026, By X, Busy, Recurring event"
 * Online meetings say "Microsoft Teams Meeting" in the label; in-progress ones
 * additionally expose a live "Join" button (aria-label "Join Teams meeting").
 *
 * Each event element's subtree is also scanned for a href*="meetup-join" link
 * so we can join via URL (reliable) instead of clicking through OWA popovers.
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
  /** direct Teams join URL scraped from the event card's subtree */
  joinUrl?: string;
}

const ARIA_RE =
  /^(.+?),\s*(\d{1,2}:\d{2}\s?(?:AM|PM))\s+to\s+(\d{1,2}:\d{2}\s?(?:AM|PM)),\s*([A-Za-z]+),\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/;

export async function parseCalendar(frame: Frame): Promise<Meeting[]> {
  const raw = await frame.evaluate(() => {
    const out: { aria: string; idx: number; joinUrl: string | null }[] = [];
    let idx = 0;
    for (const el of document.querySelectorAll("[aria-label]")) {
      const aria = el.getAttribute("aria-label") ?? "";
      if (/\d{1,2}:\d{2}\s?(AM|PM)\s+to\s+\d{1,2}:\d{2}\s?(AM|PM)/i.test(aria)) {
        // look for a meetup-join link inside this event element or its closest container
        let joinUrl: string | null = null;
        const parent = el.closest("[data-testid], [role='button'], [role='gridcell']") ?? el;
        const link = parent.querySelector('a[href*="meetup-join"]') as HTMLAnchorElement | null;
        if (link) joinUrl = link.href;
        // also check siblings (OWA sometimes puts the join link next to the card)
        if (!joinUrl) {
          const prev = el.previousElementSibling;
          if (prev) {
            const sibLink = prev.querySelector('a[href*="meetup-join"]') as HTMLAnchorElement | null;
            if (sibLink) joinUrl = sibLink.href;
          }
        }
        out.push({ aria, idx, joinUrl });
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
      joinUrl: r.joinUrl ?? undefined,
    });
  }
  // dedupe by title+start (an event can have two aria-label elements — outer card + inner bubble)
  const seen = new Map<string, Meeting>();
  for (const mt of meetings) {
    const key = `${mt.title}__${mt.start.getTime()}`;
    const existing = seen.get(key);
    if (existing) {
      // prefer the one with a joinUrl
      if (mt.joinUrl && !existing.joinUrl) seen.set(key, mt);
    } else {
      seen.set(key, mt);
    }
  }
  return [...seen.values()];
}

/** Mark events whose start/end window contains now as joinable. */
export function markInProgress(meetings: Meeting[]): Meeting[] {
  const now = Date.now();
  for (const m of meetings) {
    m.joinableNow = now >= m.start.getTime() && now < m.end.getTime();
  }
  return meetings;
}
