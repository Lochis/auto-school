/**
 * Teams web login with persistent profile + MFA Discord ping.
 *
 * Uses the modular auth-state machine (auth-state.ts) — each auth screen
 * is a named handler, the loop just detects → handles → polls.
 */
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { chromium, type Page, type BrowserContext } from "playwright";
import { config } from "../config.ts";
import { outPath } from "../paths.ts";
import {
  type AuthState,
  detectState,
  handleConsent,
  handleEmail,
  handlePassword,
  handleAccountPicker,
  handleMfaPush,
  handleMfaTotp,
  handleKmsi,
  handleSecurityWizard,
  handlePasswordExpired,
  handleSsoLogin,
  handleAuthFailure,
  handleProcessing,
  handleUnknown,
} from "./auth-state.ts";

const TEAMS_URL = "https://teams.microsoft.com";
const POLL_MS = 800;

export interface LoginResult {
  ok: boolean;
  method: "fresh" | "session";
  detail: string;
  page?: Page;
  ctx?: BrowserContext;
}

/** Find the tab with a login form (MS login, school SSO, consent, etc.) */
async function findActionablePage(ctx: BrowserContext): Promise<Page | null> {
  for (const p of ctx.pages()) {
    if (p.isClosed()) continue;
    const url = p.url();
    if (/login|microsoftonline|myLogin|consent|commonauth|aka\.ms/.test(url)) return p;
    // check if the page has login elements
    const has = await p.locator('input[type="email"], input[type="password"], #centennial_username, button:has-text("Continue")').first().isVisible({ timeout: 400 }).catch(() => false);
    if (has) return p;
  }
  return null;
}

export async function teamsLogin(opts: { fresh?: boolean; keepOpen?: boolean; hold?: boolean } = {}): Promise<LoginResult> {
  const keepOpen = opts.keepOpen || opts.hold;
  const profileDir = resolve(config.dataDir, "teams-profile");
  mkdirSync(profileDir, { recursive: true });

  // clear stale locks from previous unclean shutdowns
  try { rmSync(join(profileDir, "SingletonLock"), { force: true }); } catch { /* */ }
  try { rmSync(join(profileDir, "SingletonSocket"), { force: true }); } catch { /* */ }
  try { rmSync(join(profileDir, "SingletonCookie"), { force: true }); } catch { /* */ }

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--use-fake-ui-for-media-stream",
      "--disable-features=MediaStream",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 1280, height: 800 },
    timeout: 60_000,
  }).catch(async (e) => {
    console.warn(`[login] launch failed (${String(e).slice(0, 90)}) — clearing stale profile locks, retrying`);
    rmSync(profileDir, { recursive: true, force: true });
    mkdirSync(profileDir, { recursive: true });
    return chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--use-fake-ui-for-media-stream", "--disable-features=MediaStream"],
      ignoreDefaultArgs: ["--enable-automation"],
      viewport: { width: 1280, height: 800 },
      timeout: 60_000,
    });
  });

  let page = ctx.pages()[0] ?? await ctx.newPage();
  ctx.on("requestfailed", (r) => {
    if (r.failure()?.errorText !== "net::ERR_ABORTED")
      console.log(`[login] request failed: ${r.url().slice(0, 90)} — ${r.failure()?.errorText}`);
  });

  console.log(`[login] navigating to ${TEAMS_URL} ...`);
  await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  console.log(`[login] landed on ${page.url()}`);

  // credentials
  const email = config.email || "";
  const password = config.password || config.centennialPassword || "";
  const totpSecret = config.totpSecret;
  const mfaDeadline = Date.now() + config.mfaWaitMs;
  const started = Date.now();
  let mfaPushNotified = false;
  let lastState: AuthState = "unknown";
  let sameStateCount = 0;
  let sawLoginUrl = false;
  let iter = 0;

  while (true) {
    // check for a new tab (MS sometimes opens one)
    const actionable = await findActionablePage(ctx);
    if (actionable && actionable !== page) {
      console.log(`[login] switching to tab: ${actionable.url().slice(0, 60)}`);
      page = actionable;
    }

    const url = page.url();
    if (/login\.microsoftonline\.com|authenticationendpoint|\/commonauth|aka\.ms/.test(url)) sawLoginUrl = true;

    // detect current state
    const state = await detectState(page);

    // track stuck states
    if (state === lastState) {
      sameStateCount++;
      if (sameStateCount > 30 && state !== "processing" && state !== "mfa-push") {
        console.log(`[login] stuck in state "${state}" for ${sameStateCount} iterations — taking screenshot and waiting`);
        await page.screenshot({ path: outPath("login-stuck.png") }).catch(() => {});
        sameStateCount = 0;
      }
    } else {
      sameStateCount = 0;
      lastState = state;
    }

    // ── terminal states ──
    if (state === "teams-ready") {
      const method = (!sawLoginUrl || iter < 3) ? "session" : "fresh";
      console.log(`[login] ✓ teams-ready (method=${method}, ${iter} iterations)`);
      if (keepOpen) return { ok: true, method, detail: "teams-ready", page, ctx };
      await ctx.close();
      return { ok: true, method, detail: "teams-ready" };
    }

    // ── timeout check ──
    if (Date.now() > mfaDeadline) {
      const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
      await ctx.close();
      return { ok: false, method: "fresh", detail: `login timed out in state "${state}" after ${Math.round((Date.now() - started) / 1000)}s` };
    }

    // ── handle state ──
    switch (state) {
      case "consent":
        await handleConsent(page);
        break;
      case "email":
        if (email) await handleEmail(page, email);
        else { await ctx.close(); return { ok: false, method: "fresh", detail: "no email configured" }; }
        break;
      case "password":
        if (password) await handlePassword(page, password);
        else { await ctx.close(); return { ok: false, method: "fresh", detail: "no password configured" }; }
        break;
      case "account-picker":
        await handleAccountPicker(page);
        break;
      case "mfa-push":
        await handleMfaPush(page, mfaPushNotified);
        break;
      case "mfa-totp":
        await handleMfaTotp(page, totpSecret);
        break;
      case "kmsi":
        await handleKmsi(page);
        break;
      case "security-wizard":
        await handleSecurityWizard(page);
        break;
      case "password-expired":
        await handlePasswordExpired(page);
        break;
      case "sso-login":
        if (email && password) await handleSsoLogin(page, email, password);
        else { await ctx.close(); return { ok: false, method: "fresh", detail: "SSO login page but no credentials configured" }; }
        break;
      case "auth-failure":
        await handleAuthFailure(page);
        break;
      case "processing":
        await handleProcessing(page);
        break;
      case "unknown":
      default:
        await handleUnknown(page);
        break;
    }

    iter++;
    await page.waitForTimeout(POLL_MS);
  }
}

/** Backwards-compatible alias used by daemon.ts / index.ts */
export const loginTeams = teamsLogin;
