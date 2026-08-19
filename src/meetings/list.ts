/**
 * Meeting discovery: read today's calendar from the logged-in Teams web UI.
 * Phase 1 is intentionally diagnostic-first — we dump raw text + screenshot +
 * any join links so selectors can be calibrated against the real DOM.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright";

export interface Meeting {
  title: string;
  time: string;
  joinUrl?: string;
}

const TIME_RE = /(\d{1,2}:\d{2}\s?(?:AM|PM)?\s?[–—-]\s?\d{1,2}:\d{2}\s?(?:AM|PM)?)/i;

export async function listMeetings(page: Page): Promise<Meeting[]> {
  mkdirSync("out", { recursive: true });

  // SPA hash navigation — works on both teams.microsoft.com and teams.cloud.microsoft
  const base = new URL(page.url()).origin;
  console.log(`[meetings] opening calendar (${base}/#/calendar) ...`);
  await page.goto(base + "/#/calendar", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8_000); // let the SPA render

  await page.screenshot({ path: "out/calendar.png" });
  const text = (await page.evaluate(() => document.body?.innerText ?? "")) ?? "";
  writeFileSync("out/calendar.txt", text);
  const joinUrls = await page
    .$$eval('a[href*="meetup-join"]', (as) => as.map((a) => (a as HTMLAnchorElement).href))
    .catch(() => [] as string[]);

  // heuristic parse: a line containing a time range, title on the same or next line
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const meetings: Meeting[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TIME_RE);
    if (!m) continue;
    const sameLineTitle = lines[i].replace(m[1], "").trim();
    const title = sameLineTitle || lines[i + 1] || "";
    meetings.push({ time: m[1].trim(), title, joinUrl: joinUrls.find((u) => true) });
  }

  console.log(`[meetings] found ${meetings.length} candidate meeting(s), ${joinUrls.length} join link(s)`);
  for (const mt of meetings) {
    console.log(`  • ${mt.time}  ${mt.title.slice(0, 60)}${mt.joinUrl ? "  [has join link]" : ""}`);
  }
  console.log("[meetings] raw dump: out/calendar.txt | screenshot: out/calendar.png");
  return meetings;
}
