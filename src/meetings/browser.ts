/**
 * Persistent-browser singleton.
 *
 * ONE Chromium persistent context (profile dir) is held for the daemon's
 * lifetime and shared by schedule builds, auto-joins and manual joins.
 * Previously every action did its own loginTeams() + ctx.close() — the
 * profile lock forces serialization, each action paid a full login
 * (~30-60s), and every login pinged Discord. With the singleton a login
 * happens at most once per pod lifetime (plus recovery).
 *
 * Health model: persistent contexts have no isConnected(); a closed context
 * throws on use. So liveness is probed best-effort (pages() throws once the
 * context is gone), and callers that hit a browser-level error call
 * invalidateBrowser() so the next getBrowser() relaunches + relogs in.
 */
import type { BrowserContext, Page } from "playwright";
import { loginTeams } from "../login/teams-login.ts";

let cached: { ctx: BrowserContext; page: Page } | null = null;
let inflight: Promise<{ ctx: BrowserContext; page: Page } | null> | null = null;
/** epoch ms of the last FAILED login attempt (0 = none) — lets the daemon
 *  stretch empty-schedule retries instead of spamming MFA pushes */
export let lastLoginFailedAt = 0;

function alive(c: { ctx: BrowserContext }): boolean {
  try { void c.ctx.pages(); return true; } catch { return false; }
}

/** Get the shared logged-in browser (launching + logging in on first use). */
export async function getBrowser(): Promise<{ ctx: BrowserContext; page: Page } | null> {
  if (cached && alive(cached)) return cached;
  cached?.ctx.close().catch(() => {}); // stale context — drop it
  cached = null;
  inflight ??= (async () => {
    try {
      const r = await loginTeams({ keepOpen: true });
      if (!r.ok || !r.ctx || !r.page) { lastLoginFailedAt = Date.now(); return null; }
      lastLoginFailedAt = 0; // healthy login clears the backoff signal
      try { await r.ctx.grantPermissions(["microphone", "camera"]); } catch { /* non-fatal */ }
      cached = { ctx: r.ctx, page: r.page };
      return cached;
    } catch (e) {
      lastLoginFailedAt = Date.now();
      console.warn(`[browser] login/launch threw: ${String(e).slice(0, 120)}`);
      return null; // getBrowser never rejects — callers see a plain miss
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Best-effort "is the Teams session still logged in?" probe on the shared
 *  home page. False = login page / sign-in form / re-auth banner visible.
 *  NEVER returns false on a probe error — a flaky check must not nuke a
 *  working browser. Same markers the login heuristic itself trusts. */
export async function authAlive(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/login\.microsoftonline|\/commonauth|aka\.ms\/|authenticationendpoint/i.test(url)) return false;
    const hasForm = await page.locator('input[type="email"], input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false);
    if (hasForm) return false;
    const txt = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (/we need you to sign in|sign in again/i.test(txt)) return false;
    return true;
  } catch {
    return true; // can't tell → assume alive
  }
}

/** Drop the shared context (next getBrowser() relaunches). Use on browser-level errors. */
export function invalidateBrowser(): void {
  const c = cached;
  cached = null;
  c?.ctx.close().catch(() => {});
}

/** Close the shared context (pod shutdown). */
export async function closeBrowser(): Promise<void> {
  const c = cached;
  cached = null;
  await c?.ctx.close().catch(() => {});
}
