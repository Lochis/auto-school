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
import { notify } from "../notify.ts";
import { outPath } from "../paths.ts";
import { pushEvent } from "../status.ts";
import { SEL } from "./selectors.ts";
import {
  type AuthState,
  detectState,
  handleConsent,
  handleEmail,
  handlePassword,
  handleAccountPicker,
  handleMfaChooser,
  handleMfaDenied,
  handleMfaPush,
  handleMfaTotp,
  handleKmsi,
  handleReAuth,
  handleSecurityWizard,
  handlePasswordExpired,
  handleSsoLogin,
  handleAuthFailure,
  handleProcessing,
  handleUnknown,
  readMfaNumber,
} from "./auth-state.ts";

export const TEAMS_URL = "https://teams.microsoft.com";
const POLL_MS = 800;

// login-attempt instrumentation state (module scope: survives attempts)
let attemptNo = 0;
let lastSeqKey = "";

/** POSITIVE authentication signal for a rendered Teams shell — the app-shell
 *  selector, or Microsoft auth cookies that are still valid for >5 min. A
 *  cached shell with half-dead cookies matches NEITHER (that trap used to
 *  pass the 20s "no sign-in UI" heuristic and left an empty calendar). */
async function verifyShell(ctx: BrowserContext, page: Page): Promise<string | null> {
  try {
    if (await page.locator(SEL.teamsApp.join(", ")).first().isVisible({ timeout: 1_500 }).catch(() => false)) return "teams-app-shell";
    const soon = Date.now() / 1000 + 300;
    const fresh = (await ctx.cookies()).some((c) =>
      /(?:^|\.)microsoftonline\.com$|(?:^|\.)teams\.(?:cloud\.)?microsoft\.com$/.test(c.domain) &&
      c.expires > soon && /auth|sess|tgt|ests/i.test(c.name));
    if (fresh) return "fresh-auth-cookies";
  } catch { /* probe failure → not verified */ }
  return null;
}

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
  const profileDir = resolve(config.userDataDir);
  if (opts.fresh) {
    rmSync(profileDir, { recursive: true, force: true });
    console.log(`[login] wiped profile at ${profileDir}`);
  }

  const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false, // headful under Xvfb (entrypoint provides DISPLAY=:99)
    channel: config.browserChannel, // msedge — Teams blocks vanilla Chromium
    chromiumSandbox: config.chromiumSandbox, // containers: CHROMIUM_SANDBOX=0
    env: { ...process.env, PULSE_SINK: process.env.REC_SINK ?? "rec", PULSE_SOURCE: `${process.env.REC_SINK ?? "rec"}.monitor` },
    timeout: 120_000, // Edge cold-start on a throttled pod can exceed 60s
    viewport: null,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
      "--start-maximized",
      `--disable-extensions-except=${resolve("extension")}`,
      `--load-extension=${resolve("extension")}`,
      "--use-fake-ui-for-media-stream",
    ],
  };
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, launchOpts);
  } catch (e) {
    // hard-killed Chromium leaves Singleton* symlinks that block relaunch
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(profileDir, f), { force: true });
    console.warn(`[login] launch failed (${String(e).slice(0, 90)}) — cleared stale profile locks, retrying`);
    ctx = await chromium.launchPersistentContext(profileDir, launchOpts);
  }

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
  const centennialUser = config.centennialUser || config.email || "";
  const centennialPassword = config.centennialPassword || config.password || "";
  const totpSecret = config.totpSecret;
  const mfaDeadline = Date.now() + config.mfaWaitMs;
  const started = Date.now();
  let mfaPushNotified = { current: false };
  let lastState: AuthState = "unknown";
  let sameStateCount = 0;
  let sameAuthFailures = 0;
  let sawLoginUrl = false;
  let firstTeamsTs: number | undefined; // continuous Teams-presence tracker (session heuristic)
  let stuckPinged = false;
  let iter = 0;

  // ── per-attempt instrumentation: every state transition → Discord + UI ──
  attemptNo++;
  const steps: string[] = [];
  const shotBudget = 15;
  let seqKey = "";
  const deniedResends = { current: 0 };
  const emitStep = async (state: AuthState): Promise<void> => {
    if (state === "unknown" || state === "processing") return; // poll noise
    seqKey += state[0];
    const num = state === "mfa-push" ? ` (${await readMfaNumber(page)})` : "";
    steps.push(state + num);
    const shot = steps.length <= shotBudget ? await page.screenshot({ type: "png" }).catch(() => undefined) : undefined;
    pushEvent(`login #${attemptNo} step ${steps.length}: ${state}${num}`);
    void notify(`🔐 login attempt #${attemptNo} step ${steps.length}/${shotBudget}: ${state}${num}`, shot).catch(() => {});
  };
  const summarize = async (ok: boolean, detail: string): Promise<void> => {
    const seq = seqKey || "(no states)";
    const same = seq === lastSeqKey;
    lastSeqKey = seq;
    const dur = Math.round((Date.now() - started) / 1000);
    const finalShot = await page.screenshot({ type: "png" }).catch(() => undefined);
    try {
      if (finalShot) { mkdirSync(dirname(outPath("x")), { recursive: true }); writeFileSync(outPath(`login-attempt-${attemptNo}.png`), finalShot); }
    } catch { /* forensics only */ }
    pushEvent(`login #${attemptNo} ${ok ? "✓" : "✗"} ${detail} [${seq}]`);
    await notify(
      same
        ? `🔐 login #${attemptNo} ${ok ? "✓" : "✗"} ${detail} — same state sequence as the previous attempt (${seq}); staying quiet.`
        : `🔐 login attempt #${attemptNo} ${ok ? "✓" : "✗"} after ${dur}s: ${steps.join(" → ") || "(no states)"} — ${detail}`,
      same ? undefined : finalShot,
    ).catch(() => {});
  };
  const done = (ok: boolean, method: "fresh" | "session", detail: string, extra: Partial<LoginResult> = {}): LoginResult => {
    void summarize(ok, detail);
    return { ok, method, detail, ...extra };
  };

  while (true) {
    // check for a new tab (MS sometimes opens one)
    const actionable = await findActionablePage(ctx);
    if (actionable && actionable !== page) {
      console.log(`[login] switching to tab: ${actionable.url().slice(0, 60)}`);
      page = actionable;
    }

    const url = page.url();
    if (/login\.microsoftonline\.com|authenticationendpoint|\/commonauth|aka\.ms/.test(url)) {
      if (!sawLoginUrl) {
        sawLoginUrl = true;
        steps.push("→MS-signin");
        void notify(`🔐 login #${attemptNo}: landed on a Microsoft sign-in page — SSO chain starting`, undefined).catch(() => {});
      }
    }

    // detect current state
    const state = await detectState(page);

    // track auth-failure loops (account-picker → auth-failure → re-navigate → unknown → repeat)
    // "unknown" and "account-picker" appear between auth-failures during redirects — don't reset
    // the counter on those transitional states, only on genuinely different login states.
    if (state === "auth-failure") {
      sameAuthFailures++;
      if (sameAuthFailures >= 5) {
        const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
        await notify(`🚨 **Teams login failing repeatedly** — ${sameAuthFailures} consecutive SSO auth failures. Password may be wrong/expired.`, shot).catch(() => {});
        await ctx.close();
        return done(false, "fresh", `SSO auth failed ${sameAuthFailures} times in a row`);
      }
    } else if (state !== "unknown" && state !== "account-picker" && state !== "processing") {
      sameAuthFailures = 0;
    }

    // track stuck states
    if (state === lastState) {
      sameStateCount++;
      if (sameStateCount > 30 && state !== "processing" && state !== "mfa-push" && state !== "mfa-chooser" && state !== "mfa-denied" && state !== "password-expired") {
        await page.screenshot({ path: outPath("login-stuck.png") }).catch(() => {});
        const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 4_000) ?? "").catch(() => "");
        if (txt) writeFileSync(outPath("login-stuck.txt"), txt);
        console.log(`[login] stuck in state "${state}" — screenshot+text dumped to out/login-stuck.*`);
        // one Discord ping with evidence — repeated cycles stay quiet
        if (!stuckPinged) {
          stuckPinged = true;
          const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
          await notify(`⚠️ **Teams login stuck** in state \`${state}\` for 30+ polls — evidence at /data/out/login-stuck.png + .txt`, shot).catch(() => {});
        }
        sameStateCount = 0;
      }
    } else {
      sameStateCount = 0;
      console.log(`[login] state: ${state}`);
      lastState = state;
      await emitStep(state);
    }

    // ── shell verification (replaces the old 20s "no sign-in UI → logged
    //    in" heuristic, which a cached shell with half-dead cookies passed
    //    forever). After 20s of no sign-in UI we require a POSITIVE signal
    //    (app shell selector / fresh auth cookies); without one we keep
    //    polling until 45s, then fail the attempt as unverified — the
    //    browser module then counts these and wipes the poisoned profile. ──
    const onTeams = url.startsWith("https://teams.microsoft.com") || url.startsWith("https://teams.cloud.microsoft");
    if (onTeams && state !== "teams-ready") {
      const signInUi = await page.evaluate(() => /sign in/i.test(document.body?.innerText ?? "")).catch(() => false);
      const loginForm = await page.locator('input[type="email"], input[type="password"]').first().isVisible({ timeout: 300 }).catch(() => false);
      if (!signInUi && !loginForm) {
        firstTeamsTs ??= Date.now();
        const elapsed = Date.now() - firstTeamsTs;
        if (elapsed > 20_000) {
          const signal = await verifyShell(ctx, page);
          if (signal) {
            console.log(`[login] ✓ logged in (verified: ${signal})`);
            if (keepOpen) return done(true, "session", `verified-shell(${signal})`, { page, ctx });
            await ctx.close();
            return done(true, "session", `verified-shell(${signal})`);
          }
          if (elapsed > 45_000) {
            console.log("[login] ✗ Teams shell rendered but no fresh auth signal after 45s — unverified, failing attempt");
            await ctx.close().catch(() => {});
            return done(false, "fresh", "unverified-shell");
          }
        }
      } else {
        firstTeamsTs = undefined;
      }
    } else {
      firstTeamsTs = undefined;
    }

    // ── terminal states ──
    if (state === "teams-ready") {
      const method = (!sawLoginUrl || iter < 3) ? "session" : "fresh";
      console.log(`[login] ✓ teams-ready (method=${method}, ${iter} iterations)`);
      if (keepOpen) return done(true, method, "teams-ready", { page, ctx });
      await ctx.close();
      return done(true, method, "teams-ready");
    }

    // ── timeout check ──
    if (Date.now() > mfaDeadline) {
      const shot = await page.screenshot({ type: "png" }).catch(() => undefined);
      await ctx.close();
      // tell the human the window closed — otherwise the attempt silently
      // dies and the next push only appears after the daemon's backoff
      if (state.startsWith("mfa")) {
        await notify(`⌛ **Teams login: no MFA approval in time** — attempt gave up in state "${state}" after ${Math.round((Date.now() - started) / 60_000)} min. The daemon retries shortly; approve the **next** push when it arrives.`, shot).catch(() => {});
      }
      return done(false, "fresh", `login timed out in state "${state}" after ${Math.round((Date.now() - started) / 1000)}s`);
    }

    // ── handle state ──
    switch (state) {
      case "consent":
        await handleConsent(page, { email: centennialUser || email, password: centennialPassword || password });
        break;
      case "email":
        if (email) await handleEmail(page, email);
        else { await ctx.close(); return done(false, "fresh", "no email configured"); }
        break;
      case "password":
        if (password) await handlePassword(page, password);
        else { await ctx.close(); return done(false, "fresh", "no password configured"); }
        break;
      case "account-picker":
        await handleAccountPicker(page, email);
        break;
      case "mfa-push":
        await handleMfaPush(page, mfaPushNotified);
        break;
      case "mfa-chooser":
        await handleMfaChooser(page, totpSecret, mfaPushNotified);
        break;
      case "mfa-denied": {
        const sent = await handleMfaDenied(page, mfaPushNotified, deniedResends);
        if (!sent) { // denied again after our one resend — stop pinging the human
          await notify(`🚫 login #${attemptNo}: MFA push denied twice — giving up this attempt (the daemon retries later).`).catch(() => {});
          await ctx.close().catch(() => {});
          return done(false, "fresh", "mfa-denied-twice");
        }
        break;
      }
      case "mfa-totp":
        await handleMfaTotp(page, totpSecret, mfaPushNotified); // same once-only ping guard
        break;
      case "kmsi":
        await handleKmsi(page);
        break;
      case "re-auth":
        await handleReAuth(page);
        break;
      case "security-wizard":
        await handleSecurityWizard(page);
        break;
      case "password-expired":
        await handlePasswordExpired(page);
        break;
      case "sso-login":
        if (email && password) await handleSsoLogin(page, email, password);
        else { await ctx.close(); return done(false, "fresh", "SSO login page but no credentials configured"); }
        break;
      case "auth-failure":
        await handleAuthFailure(page, email, password);
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
