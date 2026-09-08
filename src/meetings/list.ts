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
  // dump what the page actually looks like BEFORE trying to click —
  // the selector fires first on a fresh Teams shell and we need evidence
  await page.screenshot({ path: outPath("pre-calendar.png") }).catch(() => {});
  const preShot = await page.screenshot({ type: "png" }).catch(() => undefined);
  await notify("📸 pre-calendar click", preShot).catch(() => {});
  const cal = page.locator('[data-tid*="calendar"], [aria-label*="Calendar"], [title*="Calendar"]')
    .filter({ hasText: /^\s*Calendar\s*$/ }).first();
  if (!(await cal.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await page.getByText("Calendar", { exact: true }).first().click({ timeout: 5_000 });
  } else {
    await cal.click();
  }
  console.log("[meetings] Calendar rail clicked");
  // wait for the OWA calendar frame to actually appear (Teams loads slowly
  // on a throttled pod — the "Thanks for hanging in there!" screen can
  // linger for 30+s before the calendar iframe renders)
  const owaFrame = await page.waitForFunction(() =>
    [...document.querySelectorAll('iframe')].some((f) => f.src?.includes('outlook.office.com')),
    { timeout: 45_000 },
  ).catch(() => null);
  if (!owaFrame) {
    console.log("[meetings] ! OWA calendar frame never appeared after 45s — dumping evidence");
    const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
    await notify("📸 calendar frame never appeared — full page", shot).catch(() => {});
    return [];
  }
  await page.waitForTimeout(10_000); // let the calendar events render inside the frame
  const postShot = await page.screenshot({ type: "png" }).catch(() => undefined);
  await notify("📸 after Calendar click (Week view)", postShot).catch(() => {});

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
