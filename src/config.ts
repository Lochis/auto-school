/** Env config. Node has no auto-.env; Bun users get it free but we run under Node on Windows. */
import { homedir } from "node:os";
import { join } from "node:path";

try { process.loadEnvFile(); } catch { /* no .env — env vars may come from elsewhere */ }

export const config = {
  email: process.env.TEAMS_EMAIL ?? "",
  password: process.env.TEAMS_PASSWORD ?? "",
  centennialUser: process.env.CENTENNIAL_USER ?? "",
  centennialPassword: process.env.CENTENNIAL_PASSWORD ?? "",
  discordWebhook: process.env.DISCORD_WEBHOOK_URL ?? "",
  // Default: LOCAL disk (repo may sit on a network drive — Chromium profiles stall there)
  userDataDir: process.env.USER_DATA_DIR ?? join(homedir(), ".auto-school", "user-data"),
  mfaWaitMs: (Number(process.env.MFA_WAIT_MINUTES ?? 10) || 10) * 60_000,
  /** "" -> bundled Chromium; "msedge" -> Edge channel */
  browserChannel: process.env.BROWSER_CHANNEL || undefined,
  /** Chromium sandbox. Containers without unprivileged userns must set CHROMIUM_SANDBOX=0 */
  chromiumSandbox: process.env.CHROMIUM_SANDBOX !== "0",
  /** Base32 TOTP secret — enables fully-automatic MFA via "use a verification code" */
  totpSecret: process.env.TOTP_SECRET || "",
};
