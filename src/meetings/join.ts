/**
 * Meeting join flow: from a parsed calendar event -> inside the meeting,
 * mic/cam off, ready for the recorder phase.
 *
 * Path: click event card in OWA frame -> details popover "Join" button ->
 * Teams meeting opens (new tab or in-app) -> pre-join screen: mic/cam OFF ->
 * "Join now" -> wait for "Leave" confirmation.
 */
import type { BrowserContext, Page } from "playwright";
import { notify } from "../notify.ts";
import type { Meeting } from "./parse.ts";

export const JOIN_SEL = {
  // pre-join screen
  micToggle: 'button[aria-label*="Mic"], [data-tid*="toggle-mute"] > button, [data-tid="prejoin-audio-button"]',
  camToggle: 'button[aria-label*="camera"], [data-tid*="toggle-video"] > button, [data-tid="prejoin-video-button"]',
  joinNow: '[data-tid="prejoin-join-button"], button:has-text("Join now")',
  // inside meeting
  inMeeting: '[data-tid="call-screen"], [data-tid="presentation-status"], button[aria-label*="Leave"]',
  // generic dialogs
  dialogOk: 'button[aria-label="OK"], button:has-text("Got it"), button:has-text("Allow")',
} as const;

async function settleJoin(page: Page): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const url = page.url();
    // 1. already in the meeting?
    if (url.includes("/meet/") || url.includes("meeting")) {
      const inCall = await page.locator(JOIN_SEL.inMeeting).first()
        .isVisible({ timeout: 1_000 }).catch(() => false);
      if (inCall) return true;
    }
    // 2. pre-join screen?
    const joinBtn = page.locator(JOIN_SEL.joinNow).first();
    if (await joinBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      // toggle mic + cam OFF first (only if the toggles read as on)
      for (const sel of [JOIN_SEL.micToggle, JOIN_SEL.camToggle]) {
        try {
          const b = page.locator(sel).first();
          if (await b.isVisible({ timeout: 800 })) {
            const label = await b.getAttribute("aria-label");
            if (label && !/mute|off|turn off/i.test(label)) await b.click(); // reads "on" -> click off
          }
        } catch { /* optional */ }
      }
      // dismiss any "allow mic/cam" dialogs
      const ok = page.locator(JOIN_SEL.dialogOk).first();
      if (await ok.isVisible({ timeout: 300 }).catch(() => false)) await ok.click().catch(() => {});
      await joinBtn.click({ timeout: 3_000 });
      console.log("[join] Join now clicked");
      continue;
    }
    // 3. random dialogs
    const ok = page.locator(JOIN_SEL.dialogOk).first();
    if (await ok.isVisible({ timeout: 300 }).catch(() => false)) {
      await ok.click().catch(() => {});
      console.log("[join] dialog dismissed");
    }
    await page.waitForTimeout(1_000);
  }
  return false;
}

/** Join `meeting`. Returns the page the call lives in (for recording) or null. */
export async function joinMeeting(
  ctx: BrowserContext,
  meeting: Meeting,
): Promise<Page | null> {
  console.log(`[join] joining: ${meeting.title}`);
  await notify(`🎬 auto-school is **joining**: ${meeting.title}`);

  // 1. click the event card in the OWA frame -> details popover
  const card = meeting.frame.locator(`[aria-label*="${meeting.title.slice(0, 40)}"]`).first();
  if (await card.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await card.click();
    console.log("[join] event card clicked");
    await meeting.frame.waitForTimeout(1_500);
  }

  // 2. details popover: click a Join button (may be on popover or the card itself)
  let clicked = false;
  for (const f of ctx.pages().flatMap((p) => p.frames())) {
    for (const sel of ['button[aria-label*="Join Teams meeting"]', 'button:has-text("Join")']) {
      try {
        const b = f.locator(sel).first();
        if (await b.isVisible({ timeout: 800 })) {
          await b.click();
          clicked = true;
          console.log(`[join] Join button clicked (frame: ${f.url().slice(0, 60)})`);
          break;
        }
      } catch { /* keep looking */ }
    }
    if (clicked) break;
  }
  if (!clicked) {
    console.log("[join] ! no Join button found — not joinable yet (meeting not started?)");
    return null;
  }

  // 3. the meeting opens wherever it opens — find the join UI on ANY page
  await ctx.pages()[0].waitForTimeout(3_000);
  let target: Page | null = null;
  for (const p of ctx.pages()) {
    if (await p.locator(JOIN_SEL.joinNow).first().isVisible({ timeout: 800 }).catch(() => false)) {
      target = p;
      break;
    }
  }
  target ??= ctx.pages().find((p) => p.url().includes("/meet/")) ?? null;
  if (!target) {
    console.log("[join] ! meeting page never appeared");
    return null;
  }

  // 4. run the pre-join state machine on it
  if (!(await settleJoin(target))) {
    console.log("[join] ! never reached in-meeting state");
    return null;
  }
  console.log(`[join] ✓ in meeting: ${meeting.title}`);
  await notify(`✅ In meeting: ${meeting.title} — recording phase can start`);
  return target;
}
