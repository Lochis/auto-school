# Hosted platform — commercial architecture after the pod-per-user pivot

Status: DECIDED DIRECTION (2026-10-20). **5a manifest cutover APPLIED 2026-10-29** and
**5b-2(c) platform AI is LIVE** (§5 item 5, §1.6). Pod-per-user workers are DEAD: the recording daemon
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

**The personal k3s pod remains the reference implementation of the client half** (record →
transcribe → submit), talking to PG directly instead of through the ingestion API. Since the 5a
manifest cutover (**APPLIED 2026-10-29**) it is two Deployments — `auto-school-platform`
(frontend) and `auto-school-recorder` (daemon + PVC) — with the old single-pod manifest retired;
live topology in §5 item 5a.

## 1.5 Recorder taxonomy + schedule distribution (ICS)

One contract, two variants (`recorder-split.md` registry `mode` column):

| | inbound (personal pod) | poll (hosted, Electron) |
| --- | --- | --- |
| Schedule | Graph/Teams bot (personal-only, auto-attend) | subscribes to the platform's per-user ICS feed |
| Capture | browser-joined recording (daemon) | desktop/tab audio (`desktopCapturer`/`getDisplayMedia`) + ffmpeg segments; **started by a present human** (banner + one click) — no unattended capture for non-owner users |
| Storage | PVC (never syncs) | on-device default; optional segment sync to the user's own cloud (§4) |
| Ingest | direct PG (trusted pod) | ingestion API (§3) |

ICS flows: **platform → recorder** (`/api/calendar/<feed-id>.ics`, authenticated — **NOT YET
BUILT**: no such route in `frontend/src/app/api/` today; the web app's calendar UI is still the
recorder's fs dump behind the daemon proxy — see `personal-not-commercial-phase3-gaps.md` Gap 1).
In the target state the calendar UI becomes a timetable editor for hosted users and the feed arms
record windows.
**user → platform** (import): one-time ICS/Outlook URL import populates the timetable — user's
own calendar data, no scraping, no borrowed client IDs. Same feed mechanism gives a
deadlines-ICS (platform → phone calendar) as a user feature — also **not built**.

### 1.6 Recorder/platform responsibility boundary (DECIDED 2026-10-29)

The recorder's irreducible job is **capture + submit** — nothing else. Every AI operation and
all DB interaction belongs to the **platform** (back end), independent of which recorder fed
the data in (personal pod or Electron client — the recorder type "doesn't matter" to the
back end).

| Responsibility | Where |
| --- | --- |
| Capture (browser/desktop, ffmpeg, segmenting), auto-join bot | recorder |
| Notes, deadlines, checklists generation, semantic search | **platform** (reads PG, platform-held keys) |
| Transcribe (Gemini/GLM) | recorder-side today (daemon owns the ffmpeg segments); may move to the platform |
| Session/artifact/deadline submission | ingestion API (`POST /api/ingest/session`) |

Already platform-side: chat/semantic search (embeddings in PG), materials metadata +
embeddings (Gap 3).

**Generation is now CODE-COMPLETE and LIVE on the platform (5b-2c, deployed 2026-10-29 with
`PLATFORM_AI=1` in the platform pod):** deadline rebuild, checklist generation and on-demand
notes generation run in-process on the platform over PG (`frontend/src/app/api/deadlines`,
`frontend/src/app/api/checklists`, `frontend/src/app/api/notes/generate`) instead of proxying
to the recorder's fs. No recorder is needed for them any more.

**Still recorder-side: transcription** — ffmpeg segmentation + the Gemini/GLM call stay in the
daemon (`/api/transcribe` on the platform is still a proxy to the recorder), because capture and
segment bytes live there. That is a data step, not a recorder function: the platform can also
transcribe after submit (see `platform-ai-generation.md`).

**Refactor direction (5b):** the daemon WAS a monolith that did all of this locally (historic —
it owned everything); 5b-2c moved generation to the platform and left the daemon with capture +
submit. The personal pod's direct-PG ingest is the trusted fast-path of the same contract; an
Electron client uses the API over HTTPS.

## 2. Tier decision (open — no longer gates the code; gates the hosted tier's LAUNCH)

COMMERCIALIZATION-PLAN.md drew the line at "no hosted storage of recordings/transcripts";
hosting transcripts is the new posture. Resolve as tiers, not a rewrite:

1. **Local-only tier** — one-time license, nothing leaves the laptop (the original
   differentiation; keep it sellable).
2. **Hosted-sync tier** — subscription; transcripts + derived artifacts in the platform DB
   (encrypted per-user at rest), optional recording sync to the user's OWN cloud (§4).

The tier decision **no longer gates the code** — the ingestion API v1 shipped 2026-10-29
(`ingestion-api.md`) and the pipeline code is shared either way. It gates the **hosted tier's
launch**: privacy policy + EULA become **prerequisites** (identifiable-lecture transcripts,
minors), and Gemini spend needs quota (BYOK per future-product-goals.md §D vs platform key).

## 3. The one new server component: Ingestion API

> **SHIPPED vs TARGET (2026-10-29):** `ingestion-api.md` §4 records what landed as **5b-1**:
> `POST /api/ingest/session` with `Authorization: Bearer $INGEST_TOKEN` (shared secret,
> fail-closed) **and the owner uid in the body** — no OIDC yet, no deadlines endpoint. The
> OIDC/"+ deadlines" description below is the **TARGET**; deadlines submission + the
> platform-side mutation/AI work are 5b-2 (`ingestion-api.md` §3).

The daemon writes PG directly today (same trust zone). An Electron client can't. Add
(**TARGET**, unless marked shipped):

- `POST /api/ingest/session` (+ artifacts, deadlines) — owner-authenticated wrapper around
  the existing `src/db/writes.ts` upserts (`sessionId`, `sessionArtifact`, deadline writes).
  The daemon's `/ingest` + `/transcribe` endpoints are the prototype of this surface.
  *Shipped v1:* session + transcript/notes/timeline artifacts only; deadlines are 5b-2.
- **Auth:** OIDC via authentik from the Electron shell (system-browser flow → API token).
  Requests carry the token; Phase 1's `resolveRequestOwner` pattern carries over verbatim
  (token → uid → users.id, 401 on unknown, system-owner only for internal jobs).
  *Shipped v1:* Bearer `INGEST_TOKEN` (constant-time compare, unset = 401) + `owner` uid in the
  body resolved via `getUserIdBySub` (unknown uid → 401). OIDC is 5b-2.
- **Daemon-local auth** for :7800 stays a pre-packaging checkbox (COMMERCIALIZATION-PLAN.md
  already lists it).

## 4. Storage backends — kept ON, re-scoped (2026-10-20)

Original scope was per-user blob storage incl. recordings on platform infra. New scope:

- **The platform never holds blobs.** Recordings live on the user's device; if they want
  in-app video playback, they sync segments to **their own cloud** (S3/B2/r2… via per-user
  credentials held by the client/keychain — see §6; the `user_credentials` blob of
  `authentik-federation.md` §5 is dead).
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
      recorder = own Deployment + per-owner registry (heartbeat, inbound mode). **CODE DONE**
      (`5e40545`); **manifest cutover APPLIED 2026-10-29**. The dependency was the daemon's
      media route: the platform media route proxies to the recorder when `mediaServe` is true,
      so the cutover could not land while the daemon had no file server. That route shipped as
      **5b-1 (2026-10-29)** and the cutover landed on top of it.

      Live topology — two Deployments, `deploy/k8s/auto-school.yaml` (single-pod) retired:

      | | `auto-school-platform` | `auto-school-recorder` |
      | --- | --- | --- |
      | Runs | Next.js frontend — no daemon, no `/data` mount, no node pin | the recording daemon (`:7800` controller, Xvfb/PulseAudio/Chromium/ffmpeg) |
      | Env | `PLATFORM_AI=1`, `DB_READS=1`, optional `RECORDER_TOKEN` / `INGEST_TOKEN` / `GEMINI_API_KEY` / `GLM_API_KEY` (secretKeyRef `auto-school-env`) | `PLATFORM_URL=http://auto-school:80`, `RECORDER_ENDPOINT=http://auto-school-recorder:7800`, optional `RECORDER_TOKEN` |
      | Storage / placement | none (reads PG) | PVC `auto-school-data` (Longhorn, RWO, Recreate), node-pinned `k3s-worker-02` |
      | Registry | resolves the owner's recorder via `resolveRecorder`, degrades daemon-less | heartbeats live: `mode: inbound`, `mediaServe: true` |

      Division of labour: recorder = capture + submit; platform = all DB reads/writes + AI
      generation (§1.6). The two manifests must be applied atomically — never the recorder pod
      alongside the retired single-pod (two daemons on one RWO PVC).
   b. **Ingestion API + token auth** (§3) for external Electron clients (poll-mode
      recorders); can follow without touching (a). **5b-1 ✅ DONE** (`ingestion-api.md` §4);
      **5b-2a/b ✅ DONE** (deadlines submission + trivial-mutation split); **5b-2(c) DEPLOYED
      2026-10-29** — platform-side AI generation is the live path in the platform pod
      (`PLATFORM_AI=1`). Still open: full OIDC (that doc's §3 target) and the multi-owner
      `documents` owner-scope schema migration (`ingestion-api.md` §3a.1) before any multi-owner
      rollout. Frontend must fully work with no
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
