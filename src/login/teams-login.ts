/**
 * Teams web login with persistent profile + MFA Discord ping.
 *
 * Strategy: a polling state machine instead of linear steps — robust against
 * selector churn, school SSO redirects, account pickers, and whether a step
 * is even needed (persistent profile often skips password AND MFA entirely).
 *
 * Flow:
 *   1. launchPersistentContext(user-data) -> goto teams.microsoft.com
 *   2. if redirected to MS login: fill email -> password (prompted if not in env)
 *   3. if MFA detected -> one Discord ping (includes number-matching digits
 *      when present) -> wait up to MFA_WAIT_MINUTES for you to approve
 *   4. success = we land back on teams.microsoft.com app shell
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page, type BrowserContext } from "playwright";
import { config } from "../config.ts";
import { notify } from "../notify.ts";
import { SEL, MFA_NUMBER_SEL } from "./selectors.ts";

const TEAMS_URL = "https://teams.microsoft.com";
const POLL_MS = 800;

export interface LoginResult {
  ok: boolean;
  method: "fresh" | "session" ; // session = no password re-entry needed
  detail: string;
}

/** First visible selector from a list, else null. */
async function visible(page: Page, selectors: readonly string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 1_500 })) return sel;
    } catch {
      /* not present */
    }
  }
  return null;
}

async function visibleText(page: Page, texts: readonly string[]): Promise<string | null> {
  for (const t of texts) {
    try {
      if (await page.getByText(t, { exact: false }).first().isVisible({ timeout: 1_500 })) return t;
    } catch {
      /* not present */
    }
  }
  return null;
}

/** Login UI can appear on ANY tab (Teams /v2/ opens the login in a new tab) —
 *  find the tab with actionable login UI, else null. */
async function findActionablePage(ctx: BrowserContext): Promise<Page | null> {
  for (const p of ctx.pages()) {
    if (p.isClosed()) continue;
    if (await visible(p, [SEL.email, SEL.password, SEL.centennialUser])) return p;
    for (const sel of SEL.mfa) {
      try { if (await p.locator(sel).first().isVisible({ timeout: 800 })) return p; } catch {}
    }
    if (await visibleText(p, SEL.mfaText)) return p;
  }
  return null;
}

/** WSO2 MFA picker: click the Authenticator option if present. True if clicked. */
async function tryClickAuthenticator(page: Page): Promise<boolean> {
  for (const sel of SEL.authenticatorOption) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 800 })) {
        await loc.click();
        console.log(`[login] authenticator option clicked`);
        return true;
      }
    } catch {
      /* not present */
    }
  }
  return false;
}

export async function loginTeams(opts: { fresh?: boolean; hold?: boolean } = {}): Promise<LoginResult> {
  const userDataDir = resolve(config.userDataDir);
  if (opts.fresh) {
    rmSync(userDataDir, { recursive: true, force: true });
    console.log(`[login] wiped profile at ${userDataDir}`);
  }

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // run in a VM with a desktop session (see README)
    channel: config.browserChannel,
    chromiumSandbox: true, // else Playwright passes --no-sandbox, which Edge banners as unsupported
    timeout: 30_000, // fail fast (default 180s) — a hang here means attach failed, not slow start
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  let page = ctx.pages()[0] ?? (await ctx.newPage());
  page.setDefaultTimeout(15_000);
  let lastLoggedUrl = "";
  ctx.on("page", (p) => console.log(`[login] new tab opened: ${p.url()}`));

  let urlPoll: ReturnType<typeof setInterval> | undefined;
  try {
    page.on("crash", () => console.log("[login] ! renderer CRASHED"));
    page.on("requestfailed", (r) =>
      console.log(`[login] request failed: ${r.url().slice(0, 90)} — ${r.failure()?.errorText}`));
    urlPoll = setInterval(() => console.log(`[login] url now: ${page.url()}`), 5_000);

    console.log(`[login] navigating to ${TEAMS_URL} ...`);
    await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`[login] landed on ${page.url()}`);
    clearInterval(urlPoll);

    // env only — no interactive prompts. TEAMS_PASSWORD unset => school password.
    let password: string | null = config.password || config.centennialPassword || null;
    let emailDone = false;
    let passwordDone = false;
    let centennialDone = false;
    let mfaPinged = false;
    let firstTeamsTs: number | undefined; // continuous-presence tracker for success fallback
    let sawLoginUrl = false; // proof of an actual login flow on this run
    const wasFresh = !!opts.fresh;
    let lastEmailTry = 0;
    let iter = 0;
    const mfaDeadline = Date.now() + config.mfaWaitMs;
    const started = Date.now();

    while (true) {
      // login UI may be on a different tab than the one we navigated
      const actionable = await findActionablePage(ctx);
      if (actionable && actionable !== page) {
        console.log(`[login] switching to tab: ${actionable.url()}`);
        page = actionable;
      }
      const url = page.url();
      if (url !== lastLoggedUrl) { lastLoggedUrl = url; console.log(`[login] url: ${url}`); }
      if (/login\.microsoftonline\.com|authenticationendpoint|\/commonauth|aka\.ms/.test(url)) sawLoginUrl = true;

      // ---- success: POST-LOGIN DOM only, and on fresh runs only after a login flow was seen ----
      if (url.startsWith("https://teams.microsoft.com")) {
        const signInUi = await visibleText(page, ["sign in", "get started with teams", "download teams"]);
        const shell = await visible(page, SEL.teamsApp); // specific post-login markers only
        const sawAuthFlow = sawLoginUrl || passwordDone || centennialDone;
        if (shell) { // specific post-login DOM matched — that IS proof
          const method: LoginResult["method"] = passwordDone || centennialDone ? "fresh" : "session";
          console.log(`[login] ✓ logged in (${method}) — app shell confirmed`);
          await notify(`✅ Teams login **succeeded** (${method} login)`);
          if (opts.hold) {
            console.log("[login] --hold: browser stays open until Ctrl+C");
            await new Promise(() => {});
          }
          await ctx.close();
          return { ok: true, method, detail: url };
        }
        // fallback: authed-session heuristic — only when a login flow happened (fresh)
        // or the profile pre-existed (session), and page stayed clean 20s+
        if (!signInUi && (sawAuthFlow || !wasFresh)) {
          firstTeamsTs ??= Date.now();
          if (Date.now() - firstTeamsTs > 20_000) {
            console.log(`[login] ✓ logged in (20s on Teams, no sign-in UI)`);
            await notify(`✅ Teams login **succeeded** (heuristic: 20s on Teams, no sign-in UI)`);
            if (opts.hold) {
              console.log("[login] --hold: browser stays open until Ctrl+C");
              await new Promise(() => {});
            }
            await ctx.close();
            return { ok: true, method: "session", detail: url };
          }
        } else {
          firstTeamsTs = undefined;
        }
        // fresh profile still sitting on /v2/ before its login redirect: keep waiting,
        // NEVER declare success here — /v2/ is also the pre-login landing.
      } else {
        firstTeamsTs = undefined;
      }

      // ---- on a login page (microsoftonline / school IdP redirect) ----
      const isLoginPage = /login\.microsoftonline\.com|\/login|aka\.ms/.test(url) ||
        (await visible(page, [SEL.email, SEL.password])) !== null;

      if (isLoginPage) {
        // ---- Centennial myLogin (WSO2 IdP): 9-digit ID + password on one form ----
        // MUST run before the generic password branch below — that branch would
        // otherwise type the *Teams* password into Centennial's #password field.
        const centUser = await visible(page, [SEL.centennialUser]);
        if (centUser) {
          const failed = await visible(page, [SEL.centennialError]);
          if (centennialDone && failed) {
            throw new Error("Centennial myLogin rejected credentials (Authentication Failed) — check CENTENNIAL_USER / CENTENNIAL_PASSWORD");
          }
          if (!centennialDone) {
            if (!config.centennialUser || !config.centennialPassword) {
              throw new Error("Centennial myLogin page detected but CENTENNIAL_USER / CENTENNIAL_PASSWORD not set in .env");
            }
            await page.locator(SEL.centennialUser).first().fill(config.centennialUser);
            await page.locator(SEL.centennialPassword).first().fill(config.centennialPassword);
            await page.locator(SEL.centennialSubmit).first().click();
            centennialDone = true;
            console.log("[login] Centennial myLogin: credentials submitted");
            await page.waitForTimeout(2_500); // WSO2 does an AJAX /logincontext hop before form submit
            continue;
          }
          // already submitted, no error yet — waiting on redirect/MFA
          await page.waitForTimeout(POLL_MS);
          continue;
        }

        // account picker: click our tile if email is known
        if (config.email && (await visible(page, [SEL.accountTile])) &&
            (await page.getByText(config.email).first().isVisible({ timeout: 1_000 }).catch(() => false))) {
          await page.getByText(config.email).first().click();
          await page.waitForTimeout(2_000);
          continue;
        }

        const emailField = await visible(page, [SEL.email]);
        if (emailField) {
          if (!config.email) throw new Error("TEAMS_EMAIL not set in .env");
          // re-drive: if email field is STILL visible 6s after submit, the click missed — retry
          const stalled = emailDone && Date.now() - lastEmailTry > 6_000;
          if (!emailDone || stalled) {
            await page.locator(emailField).first().fill(config.email);
            const next = await visible(page, [SEL.next]);
            if (next) {
              await page.locator(SEL.next).first().click();
              emailDone = true;
              lastEmailTry = Date.now();
              console.log(stalled ? "[login] email re-submitted (page unchanged)" : "[login] email submitted");
              await page.waitForTimeout(2_000);
              continue;
            }
          }
        }

        const pwField = await visible(page, [SEL.password]);
        if (pwField && !centUser) { // centUser handled above (WSO2 #password also matches input[type=password])
          if (!password) throw new Error("password field appeared but neither TEAMS_PASSWORD nor CENTENNIAL_PASSWORD is set in .env");
          await page.locator(pwField).first().fill(password);
          (await visible(page, [SEL.next])) && (await page.locator(SEL.next).first().click());
          passwordDone = true;
          console.log("[login] password submitted");
          await page.waitForTimeout(1_500);
          continue;
        }

        // ---- heartbeat: never look "stopped" ----
        iter++;
        if (iter % 4 === 0) console.log(`[login] waiting... (url: ${url.slice(0, 80)}, tab: ${page.url().slice(0, 60)})`);

        // stay signed in? (KMSI) — real page has an ENABLED Yes (+#idBtn_Back);
        // processing placeholders have a disabled one. Wait up to 6s for enable.
        if (await visibleText(page, SEL.staySignedInText)) {
          const yes = page.locator(SEL.staySignedInYes).first();
          let clicked = false;
          for (let i = 0; i < 12 && !clicked; i++) {
            const noBtn = await visible(page, [SEL.staySignedInNo]);
            const enabled = await yes.isEnabled({ timeout: 500 }).catch(() => false);
            if (noBtn || enabled) {
              await yes.click({ timeout: 3_000 }).then(() => (clicked = true)).catch(() => {});
            } else {
              await page.waitForTimeout(500);
            }
          }
          if (clicked) {
            console.log("[login] 'stay signed in' -> clicked Yes");
            await page.waitForTimeout(1_500);
            continue;
          }
          console.log("[login] KMSI text present but Yes not clickable yet — waiting");
        }

        // ---- WSO2 MFA picker: "Select a login option" / after cannot-authenticate ----
        if (url.includes("authenticationendpoint") || (await visibleText(page, SEL.cannotAuthenticateText))) {
          if (await tryClickAuthenticator(page)) {
            await page.waitForTimeout(1_500);
            continue;
          }
        }

        // ---- MFA ----
        const mfaSel = await visible(page, SEL.mfa);
        const mfaTxt = await visibleText(page, SEL.mfaText);
        if (mfaSel || mfaTxt) {
          if (!mfaPinged) {
            mfaPinged = true;
            const matchNum = await page.locator(MFA_NUMBER_SEL).first()
              .textContent({ timeout: 2_000 }).catch(() => null);
            const num = matchNum?.match(/\d{2,3}/)?.[0];
            console.log(`[login] MFA challenge detected (${mfaSel ?? mfaTxt})${num ? ` match number: ${num}` : ""}`);
            await notify(
              `🔐 **2FA needed — auto-school is signing in to Teams**\n` +
              `The class-attendance bot needs you to approve this MFA (school myLogin or Microsoft Authenticator) so it can continue.\n` +
              (num ? `**Match number: ${num}**\n` : "") +
              `Waiting up to ${Math.round(config.mfaWaitMs / 60_000)} min.`,
            );
          }
          if (Date.now() > mfaDeadline) {
            await notify("❌ Teams login **timed out** waiting for 2FA approval.");
            throw new Error("timed out waiting for MFA approval");
          }
          await page.waitForTimeout(POLL_MS);
          continue;
        }
      }

      // still navigating / SSO redirects — keep polling under a watchdog
      if (Date.now() - started > config.mfaWaitMs + 5 * 60_000) {
        throw new Error(`login watchdog expired (stuck at ${url})`);
      }
      await page.waitForTimeout(POLL_MS);
    }
  } catch (err) {
    if (urlPoll) clearInterval(urlPoll);
    await notify(`❌ Teams login **failed**: \`${String(err).slice(0, 180)}\``);
    await ctx.close().catch(() => {});
    return { ok: false, method: "fresh", detail: String(err) };
  }
}
