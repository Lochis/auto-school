/**
 * Modular auth-state detection + handlers.
 *
 * Each handler is a small async function that takes a Playwright Page and
 * handles exactly one auth screen.  detectState() returns which state the
 * page is currently in — the caller just loops: detect → handle → poll.
 *
 * Adding a new auth screen = one detectX() + one handleX() + one case in
 * the State union.  No nested if/else spaghetti.
 */
import type { Page } from "playwright";
import { notify } from "../notify.ts";
import { outPath } from "../paths.ts";
import { SEL, MFA_NUMBER_SEL, MS_MFA } from "./selectors.ts";
import { generateTotp } from "./totp.ts";

// ─── State union ───────────────────────────────────────────────────────
export type AuthState =
  | "teams-ready"        // on teams.microsoft.com with app shell — done
  | "re-auth"            // Teams shell visible but session expired ("sign in again" banner)
  | "consent"            // "Almost there! … additional permissions" dialog
  | "email"              // email input
  | "password"           // password input
  | "account-picker"     // "Pick an account" tiles
  | "mfa-chooser"        // "sign in another way" / "I can't use my Authenticator"
  | "mfa-push"           // "Approve sign in request" (Authenticator push, incl. number matching)
  | "mfa-totp"           // TOTP / verification code input
  | "kmsi"               // "Stay signed in?" prompt
  | "security-wizard"    // "Let's keep your account secure" setup
  | "password-expired"   // password change required
  | "sso-login"          // school SSO page (Centennial myLogin etc.)
  | "auth-failure"       // "Authentication Failed" on school SSO
  | "processing"         // intermediate redirect / spinner — just wait
  | "unknown";           // unrecognized page

// ─── Detection ─────────────────────────────────────────────────────────

/** Check if any of the given selectors is visible on the page. */
async function vis(page: Page, sels: readonly string[], timeout = 500): Promise<string | null> {
  for (const s of sels) {
    if (await page.locator(s).first().isVisible({ timeout }).catch(() => false)) return s;
  }
  return null;
}

/** Check if any of the given text strings is visible on the page. */
async function visText(page: Page, texts: readonly string[], timeout = 500): Promise<string | null> {
  for (const t of texts) {
    if (await page.getByText(t, { exact: false }).first().isVisible({ timeout }).catch(() => false)) return t;
  }
  return null;
}

/** Detect which auth state the page is in. */
export async function detectState(page: Page): Promise<AuthState> {
  const url = page.url();

  // ── Teams ready ──
  if (url.startsWith("https://teams.microsoft.com") || url.startsWith("https://teams.cloud.microsoft")) {
    // The "We need you to sign in again" banner may render in a shadow DOM or
    // custom element that getByText can't reach. Fall back to innerText search.
    const needsReauth = await page.evaluate(() => {
      const t = document.body?.innerText ?? "";
      return /sign in again/i.test(t) && /sign in/i.test(t);
    }).catch(() => false);
    if (needsReauth) return "re-auth";
    const hasShell = await page.locator(SEL.teamsApp.join(", ")).first().isVisible({ timeout: 1_200 }).catch(() => false);
    if (hasShell) return "teams-ready";
  }

  // ── Consent dialog (main page or iframe) ──
  const consentBtns = [page, ...page.frames()];
  for (const ctx of consentBtns) {
    if (await ctx.getByText("Almost there", { exact: false }).first().isVisible({ timeout: 300 }).catch(() => false)) {
      return "consent";
    }
  }

  // ── School SSO login (Centennial myLogin etc.) ──
  if (await visText(page, ["sign in to your account", "myLogin", "Authentication Failed"])) {
    if (await visText(page, ["Authentication Failed"])) return "auth-failure";
    if (await vis(page, ['#centennial_username', 'input[name="username"]', '#txtUsername'])) return "sso-login";
  }

  // ── Microsoft email input ──
  if (await vis(page, [SEL.email])) return "email";

  // ── Microsoft password input ──
  if (await vis(page, [SEL.password])) return "password";

  // ── Account picker ──
  if (await visText(page, ["pick an account", "choose an account", "which account do you want"])) return "account-picker";

  // ── MFA: method chooser ("sign in another way" / can't use authenticator) ──
  if (await visText(page, [...MS_MFA.cantUseAuthenticator, "additional sign in methods"])) return "mfa-chooser";

  // ── MFA: push approval (incl. number matching) ──
  if (await visText(page, ["approve sign in request", "approve a request", "enter the number displayed"])) return "mfa-push";
  if (await vis(page, [SEL.mfaNumberMatch])) return "mfa-push"; // number-matching sign element

  // ── MFA: TOTP / verification code input ──
  if (await vis(page, [MS_MFA.totpInput, ...SEL.mfaPanels])) return "mfa-totp";
  if (await visText(page, ["enter the code", "verification code", "one-time password"])) return "mfa-totp";

  // ── KMSI: stay signed in ──
  if (await visText(page, SEL.staySignedInText)) {
    if (await vis(page, [SEL.staySignedInYes])) return "kmsi";
  }

  // ── Security wizard ──
  if (await visText(page, ["let's keep your account secure", "security info", "don't add anything now"])) return "security-wizard";

  // ── Password expired ──
  if (await visText(page, ["your password is expired", "update your password"])) return "password-expired";

  // ── Processing / spinner ──
  if (await visText(page, ["loading", "just a moment", "signing in", "verifying"])) return "processing";
  if (await page.locator("#i0289, #idBtn_Back").first().isVisible({ timeout: 300 }).catch(() => false)) return "processing";

  return "unknown";
}

// ─── Handlers ──────────────────────────────────────────────────────────
// Each handler returns true if it advanced the flow (caller should poll again).

export async function handleConsent(page: Page, creds?: { email: string; password: string }): Promise<boolean> {
  const selectors = [
    (c: Page | import("playwright").Frame) => c.getByRole("button", { name: /continue/i }),
    (c: Page | import("playwright").Frame) => c.locator("button:has-text('Continue')"),
    (c: Page | import("playwright").Frame) => c.locator("[data-testid*='continue'], [aria-label*='continue' i]"),
  ];
  let clicked = false;
  for (const ctx of [page, ...page.frames()]) {
    if (clicked) break;
    for (const sel of selectors) {
      const btn = sel(ctx).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log("[auth] consent dialog — clicking Continue");
        await btn.click({ timeout: 5_000 }).catch(() => {});
        clicked = true;
        break;
      }
    }
  }
  if (!clicked) return false;
  // wait for the post-consent redirect — often lands on school SSO
  await page.waitForTimeout(4_000);
  // check if redirected to school SSO login page
  if (await page.getByText("sign in to your account", { exact: false }).first().isVisible({ timeout: 2_000 }).catch(() => false)) {
    console.log("[auth] post-consent redirect → school SSO login page");
    await handleSsoLogin(page, creds?.email ?? "", creds?.password ?? "");
    await page.waitForTimeout(3_000);
  }
  // after SSO login + MFA, Centennial may show its own "Stay signed in?" prompt
  await handleKmsi(page);
  return true;
}

export async function handleEmail(page: Page, email: string): Promise<boolean> {
  const input = page.locator(SEL.email).first();
  if (!await input.isVisible({ timeout: 2_000 }).catch(() => false)) return false;
  console.log(`[auth] filling email: ${email}`);
  await input.fill(email);
  await page.locator(SEL.next).first().click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
  return true;
}

export async function handlePassword(page: Page, password: string): Promise<boolean> {
  const input = page.locator(SEL.password).first();
  if (!await input.isVisible({ timeout: 2_000 }).catch(() => false)) return false;
  console.log("[auth] filling password");
  await input.fill(password);
  await page.locator(SEL.next).first().click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(2_000);
  return true;
}

export async function handleAccountPicker(page: Page, email?: string): Promise<boolean> {
  // Try, in order:
  //  1. a tile whose text contains the student's email (exact account)
  //  2. any tile inside the tiles container / role=option / tile div
  //  3. text-based locator on the email
  // Falls back to "Use another account" only when explicitly requested
  // (handled by caller) — picking the wrong generic button can loop.
  const candidates: import("playwright").Locator[] = [];
  if (email) {
    candidates.push(page.locator(`[role="button"]:has-text("${email}"), [role="option"]:has-text("${email}"), div[id="tilesContainer"] div:has-text("${email}")`).first());
  }
  candidates.push(page.locator(SEL.accountTiles).first());
  if (email) candidates.push(page.getByText(email, { exact: false }).first());

  for (const tile of candidates) {
    if (await tile.isVisible({ timeout: 1_500 }).catch(() => false)) {
      console.log(`[auth] account picker — clicking tile${email ? " for " + email : ""}`);
      await tile.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
      return true;
    }
  }
  console.log("[auth] account picker — no clickable tile found");
  return false;
}

export async function handleMfaPush(page: Page, notified: { current: boolean }): Promise<boolean> {
  const isPush = (await visText(page, ["approve sign in request", "approve a request"])) || (await vis(page, [SEL.mfaNumberMatch]));
  if (!isPush) return false;
  if (!notified.current) {
    // number matching: relay the on-screen number so it can be entered on the phone
    const numTxt = await page.locator(SEL.mfaNumberMatch).first().innerText({ timeout: 1_000 }).catch(() => "");
    const num = numTxt.match(/\d+/)?.[0];
    console.log(`[auth] MFA push detected${num ? ` (number matching: ${num})` : ""} — waiting for approval on phone`);
    const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
    await notify(
      `⏳ **Teams login: approve the sign-in request on your Microsoft Authenticator app**${num ? ` — enter **${num}** in the app` : ""} — waiting up to 10 min.`,
      shot,
    ).catch(() => {});
    notified.current = true;
  }
  return true; // keep polling — caller manages deadline
}

/** MFA method chooser ("sign in another way" / "I can't use my Authenticator").
 *  If a TOTP secret is configured, switch to verification-code entry — the
 *  only method we can complete hands-free. Otherwise ping the user once. */
export async function handleMfaChooser(page: Page, totpSecret: string | undefined, notified: { current: boolean }): Promise<boolean> {
  // step 1: the "can't use authenticator" link → opens the method list
  const alt = page.getByText(MS_MFA.cantUseAuthenticator[0], { exact: false })
    .or(page.getByText("sign in another way", { exact: false })).first();
  if (await alt.isVisible({ timeout: 800 }).catch(() => false)) {
    console.log("[auth] MFA chooser — opening alternative sign-in methods");
    await alt.click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    return true; // next poll picks up the method list
  }
  // step 2: method list — pick verification code when we can auto-fill it
  if (totpSecret) {
    for (const t of MS_MFA.useVerificationCode) {
      const opt = page.getByText(t, { exact: false }).first();
      if (await opt.isVisible({ timeout: 800 }).catch(() => false)) {
        console.log("[auth] MFA chooser — switching to verification code (TOTP configured)");
        await opt.click({ timeout: 3_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        return true; // next poll → mfa-totp fills the code
      }
    }
  }
  if (!notified.current) {
    const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
    await notify("⚠️ **Teams login: MFA method chooser** — no auto-fillable option (TOTP_SECRET not set). Pick a method manually or set TOTP_SECRET.", shot).catch(() => {});
    notified.current = true;
  }
  return true;
}

export async function handleMfaTotp(page: Page, totpSecret: string | undefined, notified?: { current: boolean }): Promise<boolean> {
  const totpInput = page.locator(MS_MFA.totpInput).first();
  if (!await totpInput.isVisible({ timeout: 1_500 }).catch(() => false)) return false;
  if (!totpSecret) {
    if (!notified?.current) {
      console.log("[auth] TOTP input visible but no TOTP_SECRET set — pinging user for the code");
      const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
      await notify("🔢 **Teams login: a verification code is required** — TOTP_SECRET is not set, so it can't be auto-filled. Enter the code manually (or set TOTP_SECRET).", shot).catch(() => {});
      if (notified) notified.current = true;
    }
    return true; // keep polling in case it resolves another way
  }
  console.log("[auth] filling TOTP code");
  await totpInput.fill(generateTotp(totpSecret));
  // check "don't ask again for 30 days"
  const keep = page.locator(MS_MFA.dontAsk30d).first();
  if (await keep.isVisible({ timeout: 1_000 }).catch(() => false)) await keep.check().catch(() => {});
  await page.locator(MS_MFA.verify).first().click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(2_000);
  return true;
}

export async function handleKmsi(page: Page): Promise<boolean> {
  // Microsoft KMSI (#idSIButton9) — or Centennial/WSO2 variant ("Yes" button)
  const yes = page.locator(SEL.staySignedInYes).first();
  const altYes = page.getByRole("button", { name: /^Yes$/i }).first();
  const btn = await yes.isVisible({ timeout: 1_000 }).catch(() => false)
    ? yes
    : await altYes.isVisible({ timeout: 1_000 }).catch(() => false)
    ? altYes
    : null;
  if (!btn) return false;
  // also check "Don't show this again" if present (Centennial variant)
  const dontShow = page.getByText("don't show this again", { exact: false }).first();
  if (await dontShow.isVisible({ timeout: 500 }).catch(() => false)) await dontShow.click({ timeout: 1_000 }).catch(() => {});
  if (await btn.isEnabled({ timeout: 500 }).catch(() => false)) {
    console.log("[auth] clicking 'Stay signed in' → Yes");
    await btn.click({ timeout: 2_000 }).catch(() => {});
  } else {
    console.log("[auth] KMSI Yes not clickable — submitting form directly");
    await page.evaluate(() => {
      const f = document.querySelector('form[action="/kmsi"]');
      if (f) (f as HTMLFormElement).submit();
    });
  }
  await page.waitForTimeout(2_000);
  return true;
}

export async function handleReAuth(page: Page): Promise<boolean> {
  // Click "Sign in" on the red banner: "We need you to sign in again…"
  const btn = page.getByRole("button", { name: /sign in/i }).first();
  if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    console.log("[auth] session expired — clicking Sign in on re-auth banner");
    await btn.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    return true;
  }
  console.log("[auth] re-auth state detected but no Sign in button found");
  return false;
}

export async function handleSecurityWizard(page: Page): Promise<boolean> {
  const skip = page.getByText("don't add anything now", { exact: false }).first().or(page.getByText("Not now", { exact: true }).first());
  if (await skip.isVisible({ timeout: 1_000 }).catch(() => false)) {
    console.log("[auth] skipping security wizard");
    await skip.click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    return true;
  }
  const next = page.locator(SEL.next).first();
  if (await next.isVisible({ timeout: 500 }).catch(() => false)) {
    await next.click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
    return true;
  }
  return false;
}

export async function handlePasswordExpired(page: Page): Promise<boolean> {
  console.log("[auth] password expired — notifying user");
  const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
  await notify("🔑 **Teams password has expired** — please reset it manually.", shot).catch(() => {});
  return true; // keep polling — user must intervene
}

export async function handleSsoLogin(page: Page, username: string, password: string): Promise<boolean> {
  // Centennial myLogin or generic school IdP — fields use placeholder text,
  // custom IDs, or standard name/type attributes; try several selectors
  const userInput = page.locator(
    '#centennial_username, input[name="username"], #txtUsername, input[placeholder*="sername" i], input[type="text"]'
  ).first();
  const passInput = page.locator(
    '#centennial_password, input[name="password"], #txtPassword, input[placeholder*="assword"], input[type="password"]'
  ).first();
  if (!await userInput.isVisible({ timeout: 3_000 }).catch(() => false)) return false;
  console.log(`[auth] SSO login page — filling credentials for ${username}`);
  await userInput.fill(username);
  await passInput.fill(password);
  const signIn = page.locator('button:has-text("Sign In"), input[type="submit"]').first();
  await signIn.click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(4_000);
  return true;
}

export async function handleAuthFailure(page: Page, email?: string, password?: string): Promise<boolean> {
  // If the SSO page shows "Authentication Failed" but also has a login form,
  // the previous attempt failed — fill credentials and retry instead of
  // re-navigating to Teams (which just loops back here).
  if (email && password) {
    const userInput = page.locator(
      '#centennial_username, input[name="username"], #txtUsername, input[placeholder*="sername" i], input[type="text"]'
    ).first();
    const passInput = page.locator(
      '#centennial_password, input[name="password"], #txtPassword, input[placeholder*="assword"], input[type="password"]'
    ).first();
    if (await userInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
      console.log(`[auth] auth-failure but login form visible — retrying SSO with ${email}`);
      await userInput.fill("").catch(() => {});
      await userInput.fill(email);
      await passInput.fill(password);
      const signIn = page.locator('button:has-text("Sign In"), input[type="submit"]').first();
      await signIn.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(4_000);
      return true;
    }
  }
  console.log("[auth] authentication failed on SSO — re-navigating to Teams");
  await page.goto("https://teams.microsoft.com", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  return true;
}

export async function handleProcessing(page: Page): Promise<boolean> {
  // intermediate redirect / spinner — just wait
  return true;
}

let unknownLogs = 0;
export async function handleUnknown(page: Page): Promise<boolean> {
  if (unknownLogs++ % 5 === 0) console.log(`[auth] unknown state on ${page.url().slice(0, 80)} — waiting (${unknownLogs} polls)`);
  return true;
}

/** High-level helper: scan main page + all frames for consent dialog, click Continue. */
export async function dismissConsent(page: Page): Promise<boolean> {
  const { config } = await import("../config.ts");
  return handleConsent(page, { email: config.centennialUser || config.email || "", password: config.centennialPassword || config.password || "" });
}
