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

  await page.screenshot({ path: "out/calendar.png" });

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
  writeFileSync("out/calendar.txt", text);

  // ---- event-element dump from the OWA calendar frame (calibration pass) ----
  const calFrame = page.frames().find((f) => f.url().includes("outlook.office.com"));
  if (calFrame) {
    const evDump = await calFrame.evaluate(() => {
      const out: string[] = [];
      // OWA events: role=button with AM/PM-bearing aria-label, plus anything Join-like
      for (const el of document.querySelectorAll('[role="button"][aria-label], [aria-label*="Join"]')) {
        const al = el.getAttribute("aria-label") ?? "";
        const txt = (el as HTMLElement).innerText?.trim().slice(0, 120) ?? "";
        if (/\d{1,2}:\d{2}\s?(AM|PM)/i.test(al) || /\d{1,2}:\d{2}\s?(AM|PM)/i.test(txt) || /join/i.test(al + txt)) {
          out.push(`ARIA: ${al.slice(0, 220)} | TEXT: ${txt.replace(/\s+/g, " ")}`);
        }
      }
      return [...new Set(out)];
    }).catch(() => [] as string[]);
    writeFileSync("out/calendar-events.txt", evDump.join("\n"));
    console.log(`[meetings] event-element dump: ${evDump.length} candidates -> out/calendar-events.txt`);
    for (const e of evDump.slice(0, 10)) console.log(`  · ${e}`);
  }

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
