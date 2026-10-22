# Hosted platform — commercial architecture after the pod-per-user pivot

Status: DECIDED DIRECTION (2026-10-20). Pod-per-user workers are DEAD: the recording daemon
is personal-only (single owner, the k3s pod as it exists). The commercial product is a
**hosted web app** — the current frontend + PG, already owner-scoped by Authentik Phase 1 —
fed by an **Electron client** that records locally and submits *derived artifacts*
(transcripts, notes, deadlines), never raw audio, to an ingestion API.

This doc supersedes `multi-user-architecture.md` (pod-per-user scale-out — historical) and
re-scopes `storage-backends.md` (kept ON, see §4).

---

## 1. Product shape

Two components sharing one codebase:

| Component | What it is | Who runs it |
| --- | --- | --- |
| **Platform** | Next.js web app (this `frontend/`) + Postgres + authentik. Notes, courses, deadlines, checklists, chat/search, playback of user-cloud-synced recordings. | Us (k3s now; any host later) |
| **Electron client** | The web app shell + the capture engine: audio record/segment → Gemini transcription → notes/deadlines pipeline (the saleable IP per COMMERCIALIZATION-PLAN.md) → sync client that submits sessions via the ingestion API. Auto-attend/Teams-bot orchestration is NOT included (personal repo only). | The student, on their laptop |

**The personal k3s pod remains exactly as-is** — it is the reference implementation of the
client half (record → transcribe → submit), talking to a co-located DB instead of the
ingestion API.

## 1.5 Recorder taxonomy + schedule distribution (ICS)

One contract, two variants (`recorder-split.md` registry `mode` column):

| | inbound (personal pod) | poll (hosted, Electron) |
| --- | --- | --- |
| Schedule | Graph/Teams bot (personal-only, auto-attend) | subscribes to the platform's per-user ICS feed |
| Capture | browser-joined recording (daemon) | desktop/tab audio (`desktopCapturer`/`getDisplayMedia`) + ffmpeg segments; **started by a present human** (banner + one click) — no unattended capture for non-owner users |
| Storage | PVC (never syncs) | on-device default; optional segment sync to the user's own cloud (§4) |
| Ingest | direct PG (trusted pod) | ingestion API (§3) |

ICS flows: **platform → recorder** (`/api/calendar/<feed-id>.ics`, authenticated): the web
app's calendar UI becomes a timetable editor for hosted users; the feed arms record windows.
**user → platform** (import): one-time ICS/Outlook URL import populates the timetable — user's
own calendar data, no scraping, no borrowed client IDs. Same feed mechanism gives a
deadlines-ICS (platform → phone calendar) as a user feature.

## 2. Tier decision (open, gates the ingestion API)

COMMERCIALIZATION-PLAN.md drew the line at "no hosted storage of recordings/transcripts";
hosting transcripts is the new posture. Resolve as tiers, not a rewrite:

1. **Local-only tier** — one-time license, nothing leaves the laptop (the original
   differentiation; keep it sellable).
2. **Hosted-sync tier** — subscription; transcripts + derived artifacts in the platform DB
   (encrypted per-user at rest), optional recording sync to the user's OWN cloud (§4).

The ingestion API gates the tier; the pipeline code is shared. Legal consequence: privacy
policy + EULA become **prerequisites** for the hosted tier (identifiable-lecture transcripts,
minors), and Gemini spend needs quota (BYOK per future-product-goals.md §D vs platform key).

## 3. The one new server component: Ingestion API

The daemon writes PG directly today (same trust zone). An Electron client can't. Add:

- `POST /api/ingest/session` (+ artifacts, deadlines) — owner-authenticated wrapper around
  the existing `src/db/writes.ts` upserts (`sessionId`, `sessionArtifact`, deadline writes).
  The daemon's `/ingest` + `/transcribe` endpoints are the prototype of this surface.
- **Auth:** OIDC via authentik from the Electron shell (system-browser flow → API token).
  Requests carry the token; Phase 1's `resolveRequestOwner` pattern carries over verbatim
  (token → uid → users.id, 401 on unknown, system-owner only for internal jobs).
- **Daemon-local auth** for :7800 stays a pre-packaging checkbox (COMMERCIALIZATION-PLAN.md
  already lists it).

## 4. Storage backends — kept ON, re-scoped (2026-10-20)

Original scope was per-user blob storage incl. recordings on platform infra. New scope:

- **The platform never holds blobs.** Recordings live on the user's device; if they want
  in-app video playback, they sync segments to **their own cloud** (S3/B2/r2… via per-user
  credentials, `user_credentials` table per authentik-federation.md §5).
- `session_artifacts.storage_uri` already exists (`file://…` today, `s3://bucket/…` later).
  The media route resolves it: local path (personal pod) or presigned GET (user cloud) —
  the web app streams from the *user's* provider, not us.
- Kept because "the web app can also show the video" is a real differentiator vs Fathom's
  cloud-held recordings: same convenience, zero custody.

## 5. Build order (revised; supersedes planning/README.md steps 4–5)

1. ✅ Authentik Phase 0 — edge identity
2. ✅ Postgres migration — all 4 cutover phases
3. ✅ Authentik Phase 1 — per-request owner binding (`feat/authentik-phase1`)
4. **Multi-tenant schema hardening ("Phase 2")** — ✅ DONE (`feat/authentik-phase2`, 2026-10-21):
   sessions `UNIQUE(course_id, stem, owner_user_id)` + owner-scoped upsert/resolve/update;
   app_settings per-user overlay (system row = recorder knobs, user rows = overrides,
   shallow merge, personal-pod behavior byte-identical). fs blob ACL stays deferred (§4
   covers the hosted world; personal pod is single-user).
5. **Platform split** — two halves:
   a. **Recorder split** (`recorder-split.md`) — frontend daemon-less by default, personal
      recorder = own Deployment + per-owner registry (heartbeat, inbound mode).
   b. **Ingestion API + token auth** (§3) for external Electron clients (poll-mode
      recorders); can follow without touching (a). Frontend must fully work with no
   daemon attached (status board/autopilot surfaces degrade gracefully — local-dev mode
   already proves most of this).
6. **Electron packaging** — web app shell + capture engine + sync client; code signing,
   auto-update, offline license (COMMERCIALIZATION-PLAN.md checklist).
7. **Storage backends** (§4 scope) — per-user cloud creds + presigned playback.

## 6. What explicitly dies

- Pod-per-user workers, StatefulSet-per-user, per-user Chromium profiles/Pulse sinks on
  shared infra (`multi-user-architecture.md` — historical reference only).
- Per-user school-credential capture on the platform (authentik-federation.md §8 Phase 2 as
  written): the credentials live in the user's Electron client/keychain, never with us —
  aligns with the plan's "credential storage beyond the user's own keychain" exclusion.
