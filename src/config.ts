/** Env config (Bun auto-loads .env). */
export const config = {
  email: process.env.TEAMS_EMAIL ?? "",
  password: process.env.TEAMS_PASSWORD ?? "",
  centennialUser: process.env.CENTENNIAL_USER ?? "",
  centennialPassword: process.env.CENTENNIAL_PASSWORD ?? "",
  discordWebhook: process.env.DISCORD_WEBHOOK_URL ?? "",
  userDataDir: process.env.USER_DATA_DIR ?? "./user-data",
  mfaWaitMs: (Number(process.env.MFA_WAIT_MINUTES ?? 10) || 10) * 60_000,
  /** "" -> bundled Chromium; "msedge" -> Edge channel */
  browserChannel: process.env.BROWSER_CHANNEL || undefined,
};
