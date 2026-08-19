/** Env config (Bun auto-loads .env). */
import { homedir, join } from "node:path";

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
};
