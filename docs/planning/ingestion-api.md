# Ingestion API + recorder media route (5b-1)

Status: IN PROGRESS (2026-10-29). Implements the §1.6 boundary: recorder = capture+submit,
platform = AI+DB. This increment ships the two foundational pieces that make the platform
daemon-less and unblock the held recorder-split cutover.

## 1. Recorder media route (daemon) — unblocks the cutover

The platform media route (`frontend/src/app/api/media/[...path]/route.ts`) already proxies
to `${recorderEndpoint}/${rel}` when the recorder advertises `mediaServe`, but the daemon has
no such file server and the heartbeat posts `mediaServe: false` (`src/recorder-heartbeat.ts:65`).

- Add a file-streaming route to `src/daemon.ts` (in `handleRequest`, near the existing
  download handler `DL_RE` ~:1574 and `MATERIALS_RE` ~:1752) that serves arbitrary files under
  `DATA_DIR` (recordings/, out/, and material bytes) by relative path, mirroring the existing
  handler's streaming + HTTP Range support.
- Path safety: normalize + reject `..`/absolute escape; resolve under `DATA_DIR` (same guard
  as the platform media route's fs branch).
- The proxy currently requests `${endpoint}/<rel>` (no prefix) — add the route at the daemon
  root for `/recordings/*`, `/out/*`, and `/courses/<slug>/materials/*` (or a single generic
  `GET /media/*` + update the frontend proxy URL prefix — pick the option that avoids
  conflicting with the daemon's existing specific routes; document the choice).
- Flip `mediaServe: true` in `src/recorder-heartbeat.ts` (route now exists).
- The platform media route needs NO change if the daemon serves `${rel}` at its root; if you
  add a `/media/*` prefix instead, update `proxyRecorderMedia`'s URL build in
  `frontend/src/app/api/media/[...path]/route.ts` accordingly. Thread the existing
  `X-Auto-School-User` header (already sent) — the daemon may ignore it this phase.

## 2. Ingestion API v1 (platform) — submit derived session data

New route `frontend/src/app/api/ingest/session/route.ts` (+ wire under `/api/ingest/session`).
This is the "Electron client submits a finished session's derived text" contract. NO raw video
here (video sync is storage-backends §4). v1 accepts derived text artifacts only.

**Contract (v1):**
```
POST /api/ingest/session
Authorization: Bearer <INGEST_TOKEN>     # shared secret, constant-time compare (same pattern
                                         # as /api/recorder/heartbeat route.ts tokenOk)
Content-Type: application/json
Body: {
  owner: string,           # X-authentik-uid (authentik user pk)
  course: string,          # course slug
  name?: string,           # session display name
  date?: string,           # YYYY-MM-DD (default today)
  stem?: string,           # optional session stem (default derived like the daemon)
  transcript?: string,     # full transcript markdown
  notes?: string,          # notes markdown
  timeline?: unknown       # timeline entries (opaque JSON)
}
Response: { ok: true, sessionId: number, stem: string } | { ok:false, error } (4xx/5xx)
```

**Implementation:**
- Env `INGEST_TOKEN` (secretKeyRef optional in manifests, like RECORDER_TOKEN). Unset → 401
  (fail closed).
- Resolve `owner` uid → `users.id` via `getUserIdBySub` (`src/db/avatar.ts`) — unknown uid →
  401 "unknown owner" (never fabricate a row).
- Writes via `src/db/writes.ts` (drizzle-free, parameterized):
  `courseId(course)` → `sessionId(courseId, stem, { sessionDate: date })` →
  `upsertArtifact(sessionId, kind, relPath, init)` for `transcript` / `notes` / `timeline`
  (read `upsertArtifact`'s `ArtifactInit` shape — content is likely a `content` field; follow
  the existing daemon artifact-write pattern).
- Session stem: accept `body.stem` if present (validate `/^[\w\-.\s:]+$/`), else derive from
  course+date+seq the same way the daemon does (read how `src/daemon.ts` /ingest derives stems).
- Wrap fully in try/catch → `{ ok:false }` 500; never throw across the boundary.
- Idempotent-ish: rely on `sessionId`'s `on conflict (course_id, stem, owner_user_id) do update`
  and `upsertArtifact`'s `on conflict (session_id, kind, rel_path) do update` — resubmit =
  update, not duplicate.

**Manifests:** add `INGEST_TOKEN` (secretKeyRef `auto-school-env`, `optional: true`) to the
platform frontend env in `deploy/k8s/auto-school-platform.yaml`; leave the single-pod
`auto-school.yaml` as-is (it doesn't need it — personal pod writes PG directly).

## 3. Explicitly DEFERRED (5b-2)

- deadlines submission (dedup/merge logic lives in the daemon /deadlines handler — needs a
  platform-side deadline upsert with the same semantics first).
- deadline/checklist trivial-mutation split (toggle/dates/fold → platform-side PG).
- platform-side AI generation (transcribe/notes/checklists generation on the platform).
- full OIDC token verification (v1 uses the shared-secret + owner-uid pattern).
