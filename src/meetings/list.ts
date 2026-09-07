/**
 * Meeting discovery: read today's calendar from the logged-in Teams web UI.
 * Phase 1 is intentionally diagnostic-first — we dump raw text + screenshot +
 * any join links so selectors can be calibrated against the real DOM.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import type { Page } from "playwright";
import { parseCalendar, markInProgress, type Meeting } from "./parse.ts";
import { notify } from "../notify.ts";
import { OUT_DIR, outPath } from "../paths.ts";

export interface Meeting {
  title: string;
  time: string;
  joinUrl?: string;
}


export async function listMeetings(page: Page): Promise<Meeting[]> {
  mkdirSync(OUT_DIR, { recursive: true });

  // SPA hash navigation — works on both teams.microsoft.com and teams.cloud.microsoft
  const base = new URL(page.url()).origin;
  console.log(`[meetings] clicking Calendar rail button ...`);
  const cal = page.locator('[data-tid*="calendar"], [aria-label*="Calendar"], [title*="Calendar"]')
    .filter({ hasText: /^\s*Calendar\s*$/ }).first();
  if (!(await cal.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await page.getByText("Calendar", { exact: true }).first().click({ timeout: 5_000 });
  } else {
    await cal.click();
  }
  console.log("[meetings] Calendar rail clicked");
  await page.waitForTimeout(8_000); // let the calendar render

  await page.screenshot({ path: outPath("calendar.png") });

  // calendar likely lives in an <iframe> — body.innerText doesn't cross frames.
  // Dump EVERY frame separately so nothing hides.
  const dump: string[] = [];
  const joinUrls: string[] = [];
  for (const f of page.frames()) {
    const label = f === page.mainFrame() ? "MAIN" : (f.url().slice(0, 100) || "(no url)");
    const txt = (await f
      .evaluate(() => document.body?.innerText ?? "")
      .catch(() => "")) ?? "";
    dump.push(`===== FRAME ${label} =====\n${txt}`);
    const links = await f
      .$$eval('a[href*="meetup-join"]', (as) => as.map((a) => (a as HTMLAnchorElement).href))
      .catch(() => [] as string[]);
    joinUrls.push(...links);
  }
  const text = dump.join("\n\n");
  writeFileSync(outPath("calendar.txt"), text);

  // ---- parse events from the OWA frame (real parser, calibrated aria-labels) ----
  const calFrame = page.frames().find((f) => f.url().includes("outlook.office.com"));
  if (!calFrame) {
    console.log("[meetings] ! no OWA calendar frame found — see out/calendar.txt");
    return [];
  }
  const meetings = markInProgress(await parseCalendar(calFrame));
  console.log(`[meetings] ${meetings.length} event(s) in current view:`);
  for (const mt of meetings) {
    const flag = mt.joinableNow ? "🔴 LIVE" : mt.online ? "🌐    " : "     ";
    const t = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    const d = (x: Date) => x.toLocaleDateString([], { weekday: "short" });
    console.log(`  ${flag} ${d(mt.start)} ${t(mt.start)}–${t(mt.end)}  ${mt.title.slice(0, 55)}`);
  }
  const live = meetings.filter((m) => m.joinableNow);
  if (live.length) {
    console.log(`[meetings] in-progress right now — joinable:`);
    for (const m of live) console.log(`  → ${m.title}`);
  }
  writeFileSync(outPath("calendar-events.txt"), meetings.map((m) =>
    `${m.start.toISOString()} | ${m.end.toISOString()} | ${m.online ? 1 : 0} | ${m.joinableNow ? 1 : 0} | ${m.title}`
  ).join("\n"));
  console.log("[meetings] detail dump: out/calendar-events.txt");
  return meetings;
}
