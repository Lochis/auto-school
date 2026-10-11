# auto-school — Plan to Commercialize

> Findings from the "can I legally sell this?" investigation (2025). Decision at the top,
> details below.

## Decision

- **Current auto-school stays personal-use only.** The auto-attend premise (join + record
  while absent, automated SSO/MFA login) cannot be sold: it bundles recording-consent
  violations, lecture copyright infringement, and attendance fraud, and violates
  school/MS terms of use. See "Legal findings" below.
- **Commercialize a different product** built from the same pipeline: a **local-first,
  consent-first meeting note-taker for students**. Working name: keep the pipeline, drop
  the ghost student.

## Product direction

**One-liner:** *You click record; we do everything else* — transcription, notes,
summaries, deadline extraction, course organization. "Auto" moves from attendance to
everything after.

### Non-negotiable product principles

1. **Human present.** Recording only while the user is participating. No attend-for-me
   mode ships, ever — marketing included.
2. **Announced recording.** Recording is visible (banner/indicator + consent flow).
   The bot must never impersonate an invisible student.
3. **Local-first.** Recordings, transcripts, credentials stay on the user's machine.
   Nothing on our servers.
4. **No stored school credentials.** Auth tokens in the OS keychain; user performs their
   own MFA; we automate *from* a human-authenticated session, never the login itself.
5. **No borrowed client IDs.** Microsoft's Graph PowerShell first-party ID comes out of
   any shipped config before v1.

### Phases

**v1 — Teams only**
- One-click "record my class" while the user is present.
- Calendar awareness via **ICS only** (no Graph API, no scraping):
  - subscribed private ICS feed (Outlook "Publish calendar" URL) → auto-refresh, or
  - manual `.ics` file import (fallback when tenant disables publishing).
- Local transcription → notes → summaries → deadline extraction (existing pipeline).
- Optional export of recordings/notes to **the user's own** Google Drive or OneDrive
  (see "Storage" below).

**v2 — Multi-platform**
- Zoom and Google Meet capture (same local desktop/tab-audio capture pattern —
  platform-agnostic since capture is audio-based, not API-based).
- Calendar feeds already work for all platforms (ICS from Outlook/Google).

**Later / explore**
- Institution sales (accessibility/accommodation offices) with DPA + admin-consented
  Graph app — the only context where deeper automation is a feature, not a liability.

### Storage — the one hard rule

**We never hold recordings.** Holding them makes us:
- a data processor (GDPR/PIPEDA, breach notification, retention duties),
- a host of **infringing copies of instructors' copyrighted lectures** (DMCA takedown
  exposure, secondary liability),
- a subpoena magnet for identifiable-minor data (COPPA/FERPA-adjacent).

**Pattern:** user connects *their own* Drive/OneDrive; the local client performs the
OAuth flow and uploads **directly from the user's machine** — our servers never touch
content or tokens. Use minimal scopes (`drive.file` / app folder), never full drive
access.

## Legal findings (why the original premise is unsellable)

1. **Recording without consent.** Classes capture instructor + other students.
   All-party-consent jurisdictions (many US states; Canada Criminal Code s.184 +
   provincial privacy law) can make this a *crime*, not just a tort. Mitigation in
   product: consent capture per course, ideally in writing (instructor email = evidence
   trail).
2. **Lecture copyright.** Lectures are the instructor's work; recording + derived notes
   = copying + derivative works. Inducement liability (Grokster standard) attaches to
   *marketing* — "record without anyone knowing" copy is Exhibit A.
3. **Attendance fraud.** Auto-join-while-absent violates every academic conduct code;
   visa-mandated attendance raises stakes to deportation-level harm for users →
   reputational/liability disaster for us.
4. **Third-party ToS.** User consent ≠ school/MS consent. Automated SSO access violates
   MS conduct codes + school IT policy regardless of who owns the account. Least-bad
   tier: automate from a session the user authenticated themselves.
5. **Deployment model doesn't cure conduct.** Local Electron client fixes *data
   custody* (breach, retention, processor duties) but not consent, copyright, fraud,
   or ToS. Local-first is privacy architecture, not legal immunity.

## Market research — how incumbents ship it

All cloud SaaS at the core; the differences are in **capture**:

| Product | Capture | Notes |
|---|---|---|
| Otter | Cloud bot joins as visible participant | Bot's visibility in the participant list **is** the consent mechanism. Teams support requires *tenant admin* policy changes — the admin wall is real even for Otter. |
| Fathom | Desktop app records locally (Mac-first) | Built local capture specifically because bots get blocked on Teams. Uploads to cloud for transcription. |
| Grain | Both: cloud bot + "Desktop Capture" | Desktop Capture marketed for platforms where bots can't join (Slack Huddles, in-person). |

Implications:
- Desktop capture is the converged answer to the Teams admin wall — validates our
  Electron direction.
- Our differentiation: **local-only** (no cloud transcription/storage) for individual
  students + student pricing. None of the incumbents serve "my lectures never leave my
  laptop."
- Grain's "record even when you can't attend" marketing is a sales-team context
  (user's own colleagues, one company's policy) — **not** cover for ghost attendance
  in school classes.

## Architecture decisions (carry-over + new)

- Electron desktop client (code-signed; auto-update infra or we inherit stale-client
  liability). Offline license-key activation (Keygen/Gumroad-style) — no hosted backend.
- Daemon (:7800) local API needs auth-by-default before shipping to strangers.
- Frontend pipeline (record → transcribe → notes → deadlines → courses) is the saleable
  IP; keep it decoupled from the auto-attend orchestration, which remains
  personal-use-only.
- Repo fork/split plan: personal auto-attend tool stays private; commercial client is a
  separate repo/product sharing the pipeline as a library.

## Legal hygiene checklist (before first sale)

- [ ] LLC + EULA: user warrants consent + rights to record; 18+; arbitration; no
      academic-misconduct use clause
- [ ] Privacy policy (even though local-first — the OAuth connector needs one)
- [ ] E&O insurance; consider cyber liability
- [ ] Drop Graph PowerShell client ID from shipped config
- [ ] Open-source dependency license audit
- [ ] Trademark search on product name ("auto-school" likely needs a consumer brand)
- [ ] Code signing cert (~$300–500/yr) + auto-update pipeline
- [ ] Rewrite all public copy: no "attend for you", no "even when you can't make it"

## Explicitly out of scope for the commercial product

- Unattended joining/recording
- Credential storage beyond the user's own keychain
- Calendar scraping, borrowed first-party client IDs, any Graph API without
  admin-consented registration
- Any hosted storage of recordings/transcripts
