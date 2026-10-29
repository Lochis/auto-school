# Ingestion API + recorder media route (5b-1)

Status: 5b-1 **LANDED** (2026-10-29, verifier SHIP — see §4); 5b-2a/b **LANDED** (deadlines
submission + trivial-mutation split — see §3). Implements the §1.6 boundary: recorder = capture+submit,
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
  deadlines?: IngestDeadline[]   # optional deadline batch — see "Deadline batch" below
}
Response: { ok: true, sessionId: number, stem: string, deadlines?: DeadlineBatchSummary }
        | { ok:false, error } (4xx/5xx)
```

**Deadline batch (5b-2a) — `deadlines[]`:**
```
IngestDeadline = {
  title: string,           # required; trimmed; blank → item skipped
  course?: string,         # course slug; defaults to the body's `course`
  due?: string | null,     # YYYY-MM-DD or null
  startBy?: string | null,
}
DeadlineBatchSummary = { upserted: number, added: number, updated: number, skipped: number }
```
- **undefined vs null**: an omitted (`undefined`) field is left ALONE; `null` (or `""`) CLEARS the
  column; an unparseable date is treated as `undefined` (leave alone) — never a 400, never a guess.
- **Merge key**: course + case-insensitive, trimmed title (`lower(trim(title))`) per owner. A match
  UPDATEs, otherwise INSERT (`legacy_id` = djb2 course+title, `on conflict (course_id, title,
  legacy_id) do nothing`, then a re-update if a concurrent insert won the race).
- **Precedence**: `due_manual` wins — a date the student set by hand is never clobbered by a
  document date; `start_by` has no manual flag and is updated when supplied.
- **Cap**: the first 200 items are applied; the remainder are counted in `skipped`.
- **Per-item skip, never a request error**: non-objects, missing/blank title or course → skipped.
  The whole batch is one transaction; a hard DB failure rolls back and reports
  `error` (logged server-side) with `0` counts.
- **Additive response**: `deadlines` is present only when the request carried a `deadlines` key
  (an array, even empty → `{0,0,0,0}`). Clients that never send it see the exact v1 response.
- **Never fails a committed ingest**: the batch runs AFTER the session/artifact writes commit, in
  its own try/catch — a deadline failure is logged, not returned as a 500, and cannot roll back
  the session.

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

## 3. Deferred vs landed (5b-2)

**LANDED (5b-2a/b):**
- **deadlines submission** — ingest accepts `deadlines[]` and applies it through
  `upsertIngestDeadlines` (`src/db/deadlines.ts`): case-insensitive title merge, `due_manual`
  precedence, 200-cap, per-item skip, additive response (§2).
- **deadline/checklist trivial-mutation split** — the platform routes now run every trivial
  mutation on its own PG via the shared `src/db/deadlines.ts` implementation
  (`applyDeadlineMutation` / `applyChecklistMutation`) when `DB_READS=1`, instead of proxying:
  deadlines = toggle done, manual `due`/`startBy` + revert, delete/remove-entry, fold
  (`fold`/`acceptFold`), unfold, `declineFold`, user note; checklists = item toggle, manual add,
  item remove. Single source of truth: the daemon handlers and these routes share the module, so
  the branch ORDER (manual dates BEFORE the done-toggle) lives in one place.
  Still daemon-proxied (needs the model / course tools): `POST /api/deadlines` rebuild (LLM sweep +
  mtime manifest) and any body the classifier cannot place, and `POST /api/checklists` generation.

**Still DEFERRED:**
- platform-side AI generation (transcribe/notes/checklists generation on the platform).
- full OIDC token verification (v1 uses the shared-secret + owner-uid pattern).

## 3a. KNOWN ISSUES / FLAGGED FOLLOW-UPS (found 2026-10-29 cohesion review)

Do NOT lose these:

1. **`embedPendingSessions()` writes `documents.owner_user_id` from the hardcoded OWNER const,
   not `curOwner()`** — `src/db/ingest-embed.ts:267` (~). Ingested sessions kick this sweep
   (fire-and-forget from the ingest route), so a non-seed owner's ingested materials would be
   embedded under the system owner. Fixing it interacts with the `on conflict (course_id,
   kind, rel_path)` dedupe used by backfill + the daemon sweep — needs a coordinated change, not
   a one-liner. **Owner attribution bug, 5b-2.**
2. **`future-product-goals.md §D/BYOK` still describes the AEAD "encrypted per-user credential
   blob … in `authentik-federation.md` §5" as the plan** — that design is DEAD (credentials
   live in the user's keychain, hosted-platform.md §6). Reword §D/BYOK to keychain storage.

## 4. STATUS — 5b-1 LANDED (2026-10-29, verifier SHIP)

`feat/ingestion-api` merged to main. Verifier built a live harness (traversal/Range/streaming
probes) and caught+fixed 3 defects: (a) media route now enforces its `recordings|out|courses`
prefix allowlist — `..` collapse could otherwise reach `DATA_DIR/settings.json` (plaintext
API keys) through the platform proxy; (b) stream error handler so a mid-stream file deletion
can't crash the daemon; (c) ingestion writes run inside `ownerALS.run(ownerUserId)` — they had
filed every session under the system owner, breaking owner-scoped same-day stem reuse.

Deploy note: ingestion API + media route are CODE-ONLY (no schema change). The recorder
media route only activates for the platform after the 5a manifest cutover; the single-pod
still serves media from its own /data mount. `INGEST_TOKEN`/`RECORDER_TOKEN` secrets remain
optional (fail closed) until the cutover. The held cutover (recorder-split §5 step 3) is now
unblocked: daemon media route exists and mediaServe=true.
