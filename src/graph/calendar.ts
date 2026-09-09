/**
 * Calendar data bridge: intercept OWA's own GetCalendarEvent responses
 * (which contain the full event Body HTML with meetup-join links) and
 * extract join URLs without making any API calls ourselves.
 */
import type { Page, Frame } from "playwright";
import { notify } from "../notify.ts";
import { outPath } from "../paths.ts";

export interface CalendarEvent {
  title: string;
  start: number;
  end: number;
  joinUrl?: string;
}

function parseTime(v: { DateTime: string; TimeZone?: string } | string): number {
  if (typeof v === "string") return new Date(v).getTime();
  const tz = v.TimeZone ?? "";
  const isUtc = /utc/i.test(tz);
  const s = isUtc && !v.DateTime.endsWith("Z") ? v.DateTime + "Z" : v.DateTime;
  return new Date(s).getTime();
}

// ─── Network harvest: passive interception of OWA responses ─────────────

/**
 * Watch ALL responses from outlook.office.com during calendar load + popover
 * clicks. When a GetCalendarEvent response arrives, scan its HTML Body for
 * Teams meetup-join URLs. We don't make any calls — just read what OWA fetched.
 */
export function startNetworkHarvest(page: Page): () => CalendarEvent[] {
  const captured: unknown[] = [];

  page.on("response", async (resp) => {
    const url = resp.url();
    if (!url.includes("outlook.office") && !url.includes("graph.microsoft.com")) return;
    const ct = resp.headers()["content-type"] ?? "";
    if (!ct.includes("json")) return;
    // log ALL GetCalendarEvent calls regardless of filter outcome
    try {
      const text = await resp.text();
      if (text.length > 500 && /meetup-join|JoinUrl|onlineMeeting/i.test(text)) {
        const parsed = JSON.parse(text);
        captured.push(parsed);
        const items = parsed.Body?.ResponseMessages?.Items?.[0]?.Items;
        if (Array.isArray(items) && items[0]?.Subject) {
          const subj = items[0].Subject;
          const body = items[0].Body?.Value ?? "";
          const hasJoin = body.includes("meetup-join");
          console.log(`[graph] 📥 ${hasJoin ? "✓" : "✗"} ${subj.slice(0, 50)}`);
        }
      }
    } catch { /* not JSON or body unavailable */ }
  });

  let lastCount = -1;
  return async () => {
    // wait for in-flight response bodies to finish (poll until stable)
    for (let i = 0; i < 16; i++) {
      if (captured.length === lastCount && lastCount > 0) break;
      lastCount = captured.length;
      await new Promise((r) => setTimeout(r, 500));
    }
    const out: CalendarEvent[] = [];
    for (const c of captured) extractEventsDeep(c, out);
    return out;
  };
}

/** Pull the meetup-join URL out of an event's HTML body (Teams invite template). */
function joinFromHtml(html: string): string | null {
  const m = html.match(/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^"'<>\s]+/);
  return m ? m[0] : null;
}

/** Recursively walk JSON to find event objects with Subject + Start/End + join URL. */
function extractEventsDeep(node: unknown, out: CalendarEvent[]): void {
  if (Array.isArray(node)) { for (const n of node) extractEventsDeep(n, out); return; }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const title = obj.Subject ?? obj.subject;
  const st = obj.Start ?? obj.start;
  const en = obj.End ?? obj.end;
  if (typeof title === "string" && st && en) {
    let sTime: string | undefined;
    let eTime: string | undefined;
    let sTz: string | undefined;
    let eTz: string | undefined;
    if (typeof st === "string") {
      sTime = st;
    } else if (typeof st === "object") {
      const sObj = st as Record<string, unknown>;
      sTime = (sObj.DateTime ?? sObj.dateTime) as string;
      sTz = (sObj.TimeZone ?? sObj.timeZone) as string;
    }
    if (typeof en === "string") {
      eTime = en;
    } else if (typeof en === "object") {
      const eObj = en as Record<string, unknown>;
      eTime = (eObj.DateTime ?? eObj.dateTime) as string;
      eTz = (eObj.TimeZone ?? eObj.timeZone) as string;
    }
    if (typeof sTime === "string" && typeof eTime === "string") {
      // explicit field first, then the HTML body (Teams invite link)
      const joinField = obj.JoinUrl ?? obj.joinUrl;
      let join: string | null = typeof joinField === "string" && joinField.includes("meetup-join") ? joinField : null;
      if (!join) {
        const body = obj.Body ?? obj.body;
        const bodyStr = typeof body === "string" ? body
          : body && typeof body === "object" ? String((body as Record<string, unknown>).Value ?? "") : "";
        join = joinFromHtml(bodyStr);
      }
      if (join) {
        out.push({
          title,
          start: parseTime(typeof st === "string" ? st : { DateTime: sTime, TimeZone: sTz }),
          end: parseTime(typeof en === "string" ? en : { DateTime: eTime, TimeZone: eTz }),
          joinUrl: join,
        });
      }
    }
  }
  for (const v of Object.values(obj)) extractEventsDeep(v, out);
}

// ─── Combined harvest with fallback ─────────────────────────────────────

export async function harvestCalendarEvents(
  page: Page,
  drainNetwork: () => Promise<CalendarEvent[]>,
): Promise<CalendarEvent[]> {
  // passive network harvest — data the page already fetched during
  // calendar load + popover clicks
  const evts = await drainNetwork();
  const withUrl = evts.filter((e) => e.joinUrl);
  console.log(`[graph] network harvest: ${withUrl.length} event(s) with join URLs (of ${evts.length} total)`);

  // dedupe by title (multiple GetCalendarEvent responses per event)
  // dedupe by title + start date (same title may recur on different days
  // with DIFFERENT meeting IDs — keep each occurrence)
  const seen = new Set<string>();
  const unique = withUrl.filter((e) => {
    const key = e.title.toLowerCase() + "@" + new Date(e.start).toDateString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length) {
    for (const e of unique) {
      const d = new Date(e.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric" });
      console.log(`  📎 ${d}  ${e.title.slice(0, 50)}  →  ${e.joinUrl!.slice(0, 70)}…`);
    }
    return unique;
  }

  // nothing captured — take screenshot for diagnosis
  const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
  await notify("⚠️ Calendar API: no join URLs captured from OWA responses — using DOM scrape only", shot).catch(() => {});
  throw new Error("no join URLs from network harvest");
}
