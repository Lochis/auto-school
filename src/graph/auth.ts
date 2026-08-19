/**
 * Graph auth: device-code flow (one-time interactive approval), then cached
 * refresh tokens — fully automatic afterwards.
 *
 * First run: prints a code + URL (and pings Discord); approve in any browser,
 * sign in with the school account (MFA fine). Tokens cached to
 * ~/.auto-school/graph-tokens.json and refreshed forever after.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { notify } from "../notify.ts";

const SCOPES = ["Calendars.Read", "offline_access", "User.Read"];

const tokenPath = join(homedir(), ".auto-school", "graph-tokens.json");

interface TokenCache {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
}

async function tokenRequest(body: Record<string, string>): Promise<TokenCache> {
  const clientId = process.env.GRAPH_CLIENT_ID;
  if (!clientId) throw new Error("GRAPH_CLIENT_ID not set in .env (see README: app registration)");
  const tenant = process.env.GRAPH_TENANT_ID || "organizations";
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, ...body }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

function save(t: TokenCache) {
  mkdirSync(join(homedir(), ".auto-school"), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(t, { spaces: 2 }));
}

/** Get a valid access token: cached -> refresh -> device-code interactive. */
export async function getAccessToken(): Promise<string> {
  let cached: TokenCache | null = null;
  if (existsSync(tokenPath)) {
    try { cached = JSON.parse(readFileSync(tokenPath, "utf8")); } catch { cached = null; }
  }

  // 1. cached token still good (60s margin)
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.access_token;

  // 2. refresh
  if (cached?.refresh_token) {
    try {
      const t = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: cached.refresh_token,
        scope: SCOPES.join(" "),
      });
      save(t);
      console.log("[graph] token refreshed");
      return t.access_token;
    } catch (e) {
      console.log(`[graph] refresh failed (${String(e).slice(0, 120)}) — falling back to device code`);
    }
  }

  // 3. device code (interactive, one time)
  const clientId = process.env.GRAPH_CLIENT_ID!;
  const tenant = process.env.GRAPH_TENANT_ID || "organizations";
  const dr = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES.join(" ") }),
  });
  const dj = (await dr.json()) as any;
  if (!dr.ok) throw new Error(`devicecode ${dr.status}: ${JSON.stringify(dj).slice(0, 300)}`);

  console.log("\n═══════════════════════════════════════════════");
  console.log(`  ONE-TIME Graph consent`);
  console.log(`  Open:  ${dj.verification_uri}`);
  console.log(`  Code:  ${dj.user_code}`);
  console.log("═══════════════════════════════════════════════\n");
  await notify(`🔐 **One-time Graph consent needed** for auto-school\nOpen ${dj.verification_uri} and enter code: **${dj.user_code}**`);

  // poll until approved
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, (dj.interval ?? 5) * 1000));
    try {
      const t = await tokenRequest({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dj.device_code,
        scope: SCOPES.join(" "),
      });
      save(t);
      console.log("[graph] ✓ device-code consent complete — tokens cached");
      await notify("✅ Graph consent complete — auto-school can now read your calendar");
      return t.access_token;
    } catch (e: any) {
      const msg = String(e);
      if (msg.includes("authorization_pending")) continue;
      throw e;
    }
  }
  throw new Error("device-code consent timed out");
}
