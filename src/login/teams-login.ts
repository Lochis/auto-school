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
import { chromium, type Page } from "playwright";
import { config } from "../config";
import { notify } from "../notify";
import { SEL, MFA_NUMBER_SEL } from "./selectors";

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
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.setDefaultTimeout(15_000);

  try {
    console.log(`[login] navigating to ${TEAMS_URL} ...`);
    await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`[login] landed on ${page.url()}`);

    let password: string | null = config.password || null;
    let emailDone = false;
    let passwordDone = false;
    let centennialDone = false;
    let mfaPinged = false;
    const mfaDeadline = Date.now() + config.mfaWaitMs;
    const started = Date.now();

    while (true) {
      const url = page.url();

      // ---- success: back on Teams app shell ----
      if (url.startsWith("https://teams.microsoft.com")) {
        const shell = await visible(page, [SEL.teamsApp]);
        if (shell || Date.now() - started > 5_000) {
          const method: LoginResult["method"] = passwordDone ? "fresh" : "session";
          console.log(`[login] ✓ logged in (${method})`);
          await notify(`✅ Teams login **succeeded** (${method} login)`);
          if (opts.hold) {
            console.log("[login] --hold: browser stays open until Ctrl+C");
            await new Promise(() => {});
          }
          await ctx.close();
          return { ok: true, method, detail: url };
        }
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
        if (emailField && !emailDone) {
          if (!config.email) throw new Error("TEAMS_EMAIL not set in .env");
          await page.locator(emailField).first().fill(config.email);
          (await visible(page, [SEL.next])) && (await page.locator(SEL.next).first().click());
          emailDone = true;
          console.log("[login] email submitted");
          await page.waitForTimeout(1_500);
          continue;
        }

        const pwField = await visible(page, [SEL.password]);
        if (pwField && !centUser) { // centUser handled above (WSO2 #password also matches input[type=password])
          password ??= await promptPassword();
          await page.locator(pwField).first().fill(password);
          (await visible(page, [SEL.next])) && (await page.locator(SEL.next).first().click());
          passwordDone = true;
          console.log("[login] password submitted");
          await page.waitForTimeout(1_500);
          continue;
        }

        // stay signed in?
        if (await visibleText(page, ["stay signed in", "keep you signed in"])) {
          await page.locator(SEL.next).first().click();
          console.log("[login] 'stay signed in' -> yes (extends session life)");
          await page.waitForTimeout(1_500);
          continue;
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
              `🔐 **2FA requested** for auto-school Teams login\n` +
              `Approve/enter it (school myLogin MFA or Microsoft Authenticator).\n` +
              (num ? `**Match number: ${num}**\n` : "") +
              `Waiting up to ${Math.round(config.mfaWaitMs / 60_000)} min — session expired or first login on this profile.`,
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
    await notify(`❌ Teams login **failed**: \`${String(err).slice(0, 180)}\``);
    await ctx.close().catch(() => {});
    return { ok: false, method: "fresh", detail: String(err) };
  }
}

/** Hidden-ish console password prompt (only reached if TEAMS_PASSWORD is blank). */
async function promptPassword(): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.question("Teams password (input hidden is NOT supported in plain terminal; prefer .env): ", (a) => {
      rl.close();
      res(a);
    });
  });
}
