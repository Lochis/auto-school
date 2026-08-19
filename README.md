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

**Default path (no registration):** `.env` ships with Microsoft's **Graph PowerShell** first-party client ID (`14d82eec-...`). It's a public client with device-code flow — everything runs as **your account**, nothing to register. Just `npm run meetings`, approve the device code once, done.

If your tenant blocks that client (admin consent error), fallbacks:
1. Register your own app (below), or
2. `src/meetings/list.ts` UI-scraper (reads the logged-in Teams calendar page).

Own registration (only if needed): portal.azure.com → Entra ID → App registrations → New → Authentication → Mobile and desktop app → **Allow public client flows = Yes** → put client ID in `.env`.

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
