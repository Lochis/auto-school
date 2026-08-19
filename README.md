# auto-school

Auto-attend Teams classes: join, record, transcribe, and get AI-generated notes
even when you can't make it.

**Status: prototype — login flow only.** The login bot handles the hard part
(school SSO + MFA) with a persistent browser profile, and pings Discord when
2FA needs your hands.

## Setup

```bash
cd Y:/Repos/auto-school
bun install
bun run install-browser          # downloads Chromium for Playwright
cp .env.example .env             # fill in TEAMS_EMAIL, DISCORD_WEBHOOK_URL
```

Discord webhook: your server → Server Settings → Integrations → Webhooks →
New Webhook → Copy URL into `.env`.

## Graph API setup (meeting discovery) — one-time

1. Go to https://portal.azure.com → **Microsoft Entra ID** → **App registrations** → **New registration** (any school account can usually create one; name it `auto-school`).
2. Supported account types: **Accounts in this organizational directory only**.
3. After creation: **Authentication** → Add platform → **Mobile and desktop applications** → check `https://login.microsoftonline.com/common/oauth2/nativeclient` → and toggle **Allow public client flows = Yes** (this enables device code).
4. Copy the **Application (client) ID** into `.env` as `GRAPH_CLIENT_ID`.
5. Run `npm run meetings` — it prints a code + link (also pinged to Discord), you approve once in any browser (school login + MFA fine), tokens cache to `~/.auto-school/graph-tokens.json` and refresh automatically thereafter.

If your school blocks app registrations entirely, tell me — fallback is the Teams-calendar-UI scraper that's already in `src/meetings/list.ts`.

## Test the login flow (the prototype)

```bash
npm run login            # normal — reuses profile, usually no MFA after 1st run
npm run login:fresh      # wipe profile, forces full email+password+MFA
node src/index.ts login --hold   # keep browser open after success to inspect
```

What happens:

1. Headful Chromium opens `teams.microsoft.com` (persistent profile in `user-data/`).
2. Types email → password (prompted if not in `.env`).
3. School SSO redirect (e.g. Centennial myLogin — WSO2 IdP): auto-fills
   `CENTENNIAL_USER` + `CENTENNIAL_PASSWORD` from `.env` and submits.
4. When an MFA challenge appears (school or Microsoft), you get a **Discord ping** —
   including the **number to match** when it's an Authenticator push. You approve,
   the bot continues on its own.
5. Subsequent runs: profile session is reused → usually straight into Teams,
   no password, no MFA, no ping.

## Running in a VM

The bot uses **headful Chromium** (`headless: false`) because Teams behaves
better and the recording step will eventually need a real desktop session:

- Windows VM: just run it in a logged-in desktop session (don't lock the screen
  — Chromium throttles when the session locks; use a persistent RDP session or
  console access instead).
- Linux VM without GUI: `xvfb-run -a bun run login` works for login-only
  testing; audio loopback capture later needs a real audio stack (PulseAudio
  with a null/loopback sink, or run under a full desktop).
- Profile lives in `user-data/` — snapshot that folder once MFA is done and you
  can restore it if the VM is rebuilt.

## Roadmap

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full pipeline design
(rolling 5-min segments → frame dedupe → GLM-4.5V slide extraction →
faster-whisper transcripts → GLM 5.2 fused notes).
