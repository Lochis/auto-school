/**
 * Meeting discovery: read today's calendar from the logged-in Teams web UI.
 * Phase 1 is intentionally diagnostic-first — we dump raw text + screenshot +
 * any join links so selectors can be calibrated against the real DOM.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import type { Page, Frame } from "playwright";
import { parseCalendar, markInProgress, type Meeting } from "./parse.ts";
import { notify } from "../notify.ts";
import { OUT_DIR, outPath } from "../paths.ts";



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
  // PATIENT rail wait: the login heuristic (URL-based) can pass while the
  // app shell is still booting on a throttled pod — the rail may not exist
  // for another 30-60s. Poll for it instead of a hard 5s click that throws
  // and kills the whole cycle (which re-logs-in → the classic loop).
  const cal = page.locator('[data-tid*="calendar"], [aria-label*="Calendar"], [title*="Calendar"]')
    .filter({ hasText: /^\s*Calendar\s*$/ }).first();
  const railDeadline = Date.now() + 90_000;
  let railReady = false;
  while (Date.now() < railDeadline) {
    if (await cal.isVisible().catch(() => false)) { railReady = true; break; }
    await page.waitForTimeout(2_000);
  }
  if (!railReady) {
    // second-chance: plain text anywhere (language/localization variants)
    const alt = page.getByText("Calendar", { exact: true }).first();
    railReady = await alt.isVisible({ timeout: 5_000 }).catch(() => false);
    if (railReady) await alt.click({ timeout: 10_000 }).catch(() => {});
  }
  if (!railReady) {
    // last resort: deep link — Teams opens the calendar view directly
    console.log("[meetings] rail never appeared — deep-linking to calendar");
    await page.goto("https://teams.microsoft.com/v2/#/calendarv2", { waitUntil: "domcontentloaded" }).catch(() => {});
  } else {
    await cal.click({ timeout: 10_000 }).catch((e) => console.warn(`[meetings] rail click soft-fail: ${String(e).slice(0, 80)}`));
  }
  console.log("[meetings] Calendar rail clicked");
  await page.screenshot({ path: outPath("calendar-view.png") }).catch(() => {});
  // wait for the OWA calendar frame to appear AND have content
  // (Teams loads slowly on a throttled pod — splash screens + spinners
  // can linger 30-60s before the calendar events render)
  let calFrame: Frame | null = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    calFrame = page.frames().find((f) => f.url().includes("outlook.office.com")) ?? null;
    if (calFrame) {
      // check if the frame actually has calendar content (not just a spinner)
      const hasEvents = await calFrame.evaluate(() => {
        return [...document.querySelectorAll("[aria-label]")].some((el) =>
          /\d{1,2}:\d{2}\s?(AM|PM)\s+to\s+\d{1,2}:\d{2}\s?(AM|PM)/i.test(el.getAttribute("aria-label") ?? ""),
        );
      }).catch(() => false);
      if (hasEvents) break;
    }
    await page.waitForTimeout(2_000);
  }
  const postShot = await page.screenshot({ type: "png" }).catch(() => undefined);
  await notify("📸 after Calendar click", postShot).catch(() => {});
  if (!calFrame || !await calFrame.evaluate(() => document.body?.innerText ?? "").catch(() => "").then((t) => t.length > 50)) {
    console.log("[meetings] ! OWA calendar frame never rendered events — dumping evidence");
    return [];
  }

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
  // calFrame was already found + content-verified in the loop above
  const meetings = markInProgress(await parseCalendar(calFrame));
  console.log(`[meetings] ${meetings.length} event(s) in current view:`);
  for (const mt of meetings) {
    const flag = mt.joinableNow ? "🔴 LIVE" : mt.online ? "🌐    " : "     ";
    const t = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    const d = (x: Date) => x.toLocaleDateString([], { weekday: "short" });
    const jf = mt.joinUrl ? `  📎${mt.joinUrl.slice(0, 40)}…` : "  ⚠️ no join url";
    console.log(`  ${flag} ${d(mt.start)} ${t(mt.start)}–${t(mt.end)}  ${mt.title.slice(0, 55)}${jf}`);
  }
  const live = meetings.filter((m) => m.joinableNow);
  if (live.length) {
    console.log(`[meetings] in-progress right now — joinable:`);
    for (const m of live) console.log(`  → ${m.title}`);
  }
  // ── harvest join URLs: event card → popover → chevron menu → Copy join link ─
  // The popover has no <a> tags — the link is behind the split-button's
  // chevron (fui-MenuButton) → "Copy join link" writes it to the clipboard.
  // We intercept navigator.clipboard.writeText so nothing needs to be pasted.
  // click ALL events lacking a URL — each popover open makes OWA fetch the
  // full event (its HTML body contains the meetup-join link, which the
  // network harvest in graph/calendar.ts captures). Don't rely on the
  // online flag — its aria-label detection is flaky.
  const needUrl = meetings.filter((m) => !m.joinUrl && m.end.getTime() > Date.now() - 10 * 60_000); // skip past events (grace for in-progress)
  if (needUrl.length) {
    console.log(`[meetings] harvesting join URLs from ${needUrl.length} event popover(s)…`);
    for (const m of needUrl) {
      try {
        // title-contains locator — the form that worked in the join flow
        const safe = m.title.slice(0, 40).replace(/"/g, '\\"');
        const card = calFrame.locator(`[aria-label*="${safe}"]`).first();
        if (!(await card.isVisible({ timeout: 1_500 }).catch(() => false))) {
          console.log(`[meetings] ⬛ card NOT FOUND: "${m.title.slice(0, 40)}"`);
          continue;
        }
        console.log(`[meetings] ▶ clicking: "${m.title.slice(0, 40)}"`);
        await card.click({ timeout: 2_000 });
        await calFrame.waitForTimeout(1_200); // popover render + GetCalendarEvent fire
        await page.keyboard.press("Escape").catch(() => {});
        await page.keyboard.press("Escape").catch(() => {});
        await calFrame.waitForTimeout(800); // let the response land before next click
      } catch { /* card vanished / popover odd — skip */ }
    }
    // OWA batches GetCalendarEvent responses ~2 clicks behind — wait for the
    // tail responses before returning (the drain in calendar.ts also polls)
    await calFrame.waitForTimeout(3_000);
    // SECOND PASS: cache state changed after the first round of opens —
    // re-click events still missing a URL; their fetches often fire now
    const still = meetings.filter((m) => !m.joinUrl && m.end.getTime() > Date.now());
    if (still.length) {
      console.log(`[meetings] second pass: ${still.length} event(s) still missing URLs`);
      for (const m of still) {
        try {
          const safe = m.title.slice(0, 40).replace(/"/g, '\\"');
          const card = calFrame.locator(`[aria-label*="${safe}"]`).first();
          if (!(await card.isVisible({ timeout: 1_500 }).catch(() => false))) continue;
          await card.click({ timeout: 2_000 });
          await calFrame.waitForTimeout(1_500);
          await page.keyboard.press("Escape").catch(() => {});
          await page.keyboard.press("Escape").catch(() => {});
          await calFrame.waitForTimeout(800);
        } catch { /* skip */ }
      }
      await calFrame.waitForTimeout(3_000);
    }
    // ── DAY-VIEW PASS ──────────────────────────────────────────────────
    // Week view serves ~half the popovers from cache (no fresh fetch).
    // Day view loads each day's events on demand — every click fetches.
    // Only visit days that still have URL-less events.
    const missing = meetings.filter((m) => !m.joinUrl && m.end.getTime() > Date.now());
    if (missing.length) {
      try {
        // view switcher: direct "Day" button, or "Week ▾" dropdown first
        let dayBtn = calFrame.getByRole("button", { name: /^day$/i }).first();
        if (!(await dayBtn.isVisible({ timeout: 1_500 }).catch(() => false))) {
          const wk = calFrame.getByRole("button", { name: /week/i }).first();
          if (await wk.isVisible({ timeout: 1_500 }).catch(() => false)) {
            await wk.click({ timeout: 2_000 }).catch(() => {});
            await calFrame.waitForTimeout(500); // dropdown opens
          }
          dayBtn = calFrame.getByRole("menuitem", { name: /^day$/i }).first()
            .or(calFrame.getByText("Day", { exact: true }).first());
        }
        await dayBtn.first().click({ timeout: 2_000 }).catch(() => {});
        await calFrame.waitForTimeout(2_000); // day view renders (starts at today)
        console.log("[meetings] day-view: switched");

        // group still-missing events by calendar day
        const byDay = new Map<string, typeof missing>();
        for (const m of missing) {
          const key = m.start.toDateString();
          byDay.set(key, [...(byDay.get(key) ?? []), m]);
        }

        // arrows to move between days
        const nextArrow = calFrame.locator('[aria-label*="next" i]').first();
        const prevArrow = calFrame.locator('[aria-label*="previous" i]').first();
        const step = async (dir: 1 | -1): Promise<void> => {
          await (dir === 1 ? nextArrow : prevArrow).click({ timeout: 2_000 }).catch(() => {});
          await calFrame.waitForTimeout(900); // day loads
        };

        // day view starts at TODAY — walk day-by-day covering the missing days
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dayMs = 86_400_000;
        const minDay = Math.min(...[...byDay.keys()].map((k) => new Date(k).getTime()));
        const maxDay = Math.max(...[...byDay.keys()].map((k) => new Date(k).getTime()));
        // go back to the earliest missing day first, then forward
        for (let t = today.getTime(); t > minDay; t -= dayMs) await step(-1);
        for (let t = minDay; t <= maxDay + dayMs; t += dayMs) {
          const todays = byDay.get(new Date(t).toDateString()) ?? [];
          for (const m of todays) {
            try {
              const safe = m.title.slice(0, 40).replace(/"/g, '\\"');
              const card = calFrame.locator(`[aria-label*="${safe}"]`).first();
              if (!(await card.isVisible({ timeout: 1_200 }).catch(() => false))) continue;
              await card.click({ timeout: 2_000 });
              await calFrame.waitForTimeout(1_200);
              await page.keyboard.press("Escape").catch(() => {});
              await page.keyboard.press("Escape").catch(() => {});
              await calFrame.waitForTimeout(700);
            } catch { /* skip */ }
          }
          if (t < maxDay) await step(1);
        }
        await calFrame.waitForTimeout(2_000); // tail responses
      } catch (e) {
        console.warn(`[meetings] day-view pass failed: ${String(e).slice(0, 100)}`);
      }
    }
  }
  const got = meetings.filter((m) => m.joinUrl).length;
  console.log(`[meetings] join URLs: ${got}/${meetings.filter((m) => m.online).length} online events`);
  writeFileSync(outPath("calendar-events.txt"), meetings.map((m) =>
    `${m.start.toISOString()} | ${m.end.toISOString()} | ${m.online ? 1 : 0} | ${m.joinableNow ? 1 : 0} | ${m.title}`
  ).join("\n"));
  console.log("[meetings] detail dump: out/calendar-events.txt");
  return meetings;
}
