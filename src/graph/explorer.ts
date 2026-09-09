/**
 * Graph API bridge: pull calendar events (with join URLs) by hitting the
 * Graph REST API directly in the browser after Teams login. The persistent
 * profile holds login.microsoftonline.com ESTS session cookies from the
 * Teams login flow — these authenticate /v1.0 calls via silent AAD SSO
 * (no app registration, no device code, no consent prompts needed).
 *
 * Falls back to the OWA calendar scrape + popover harvest if the direct
 * API call returns a login redirect (ESTS session absent or expired).
 */
import type { BrowserContext } from "playwright";
import { notify } from "../notify.ts";

export interface ExplorerEvent {
  title: string;
  start: number;
  end: number;
  joinUrl: string;
}

function parseGraphTime(v: { dateTime: string; timeZone?: string }): number {
  const tz = v.timeZone ?? "";
  const isUtc = /utc/i.test(tz);
  const s = isUtc && !v.dateTime.endsWith("Z") ? v.dateTime + "Z" : v.dateTime;
  return new Date(s).getTime();
}

interface GraphEvent {
  subject?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  onlineMeeting?: { joinUrl?: string };
}

export async function listViaGraph(ctx: BrowserContext, days = 7): Promise<ExplorerEvent[]> {
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  const apiUrl =
    `https://graph.microsoft.com/v1.0/me/calendarview` +
    `?startdatetime=${start.toISOString()}` +
    `&enddatetime=${end.toISOString()}` +
    `&$select=subject,start,end,isOnlineMeeting,onlineMeeting`;

  const page = await ctx.newPage();
  try {
    console.log(`[graph] fetching calendarView directly (${days}d window)…`);
    // Navigate to the Graph API endpoint. AAD SSO (ESTS cookies from Teams
    // login) should authenticate this silently — no login page, no consent.
    // If the session is absent/expired, the browser lands on login.microsoftonline.com
    // which we detect below and treat as "not authenticated".
    const resp = await page.goto(apiUrl, { waitUntil: "load", timeout: 45_000 }).catch(() => null);
    const finalUrl = page.url();

    // ── detect login redirect (SSO failed) ──
    if (finalUrl.includes("login.microsoftonline.com") || finalUrl.includes("login.live.com")) {
      const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
      await notify("⚠️ Graph API: redirected to login — ESTS session not present", shot).catch(() => {});
      throw new Error(`redirected to login (final URL: ${finalUrl.slice(0, 80)})`);
    }

    // ── read the response body ──
    const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (!body || body.length < 10) throw new Error("empty Graph API response");

    // ── parse JSON ──
    let json: { value?: GraphEvent[] };
    try {
      json = JSON.parse(body);
    } catch {
      // Edge may wrap JSON in HTML; try extracting the JSON substring
      const m = body.match(/\{[\s\S]*"value"[\s\S]*\}/);
      if (!m) throw new Error("response is not JSON (may be a login page or HTML error)");
      json = JSON.parse(m[0]);
    }

    if (json.value?.[0]?.error) {
      throw new Error(`Graph API error: ${json.value[0].error}`);
    }

    const values = json.value ?? [];
    const out: ExplorerEvent[] = [];
    for (const e of values) {
      const joinUrl = e.onlineMeeting?.joinUrl;
      if (!joinUrl || !e.subject || !e.start || !e.end) continue;
      out.push({
        title: e.subject,
        start: parseGraphTime(e.start),
        end: parseGraphTime(e.end),
        joinUrl,
      });
    }

    console.log(`[graph] ✓ ${out.length} online event(s) with join URLs (of ${values.length} total)`);
    for (const e of out) {
      const d = new Date(e.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric" });
      console.log(`  📎 ${d}  ${e.title.slice(0, 50)}  →  ${e.joinUrl.slice(0, 65)}…`);
    }
    return out;
  } finally {
    await page.close().catch(() => {});
  }
}
