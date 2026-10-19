# Phase 3 gaps — personal vs commercial

Status: PLANNING NOTES — records what the Phase 3 read-switch (branch `feat/phase3-db-reads`,
merged to `main`) left fs-dependent, and which of those matter for the commercial product.

Three read-path gaps remained after Phase 3. This doc splits them into:
- **Personal-only** (Gaps 1–2) — owner conveniences for the personal auto-join flow; **deferred,
  not commercial**. The commercial product gives each user their own meeting source, so these
  do not transfer.
- **Commercial** (Gaps 3–4) — materials metadata/embeddings and avatar storage; **in scope**,
  because every user hits them and neither should depend on the auth provider's live API.

---

## Gap 1 — Calendar (`out/calendar-events.txt` + `out/n.txt`) — PERSONAL, deferred

**What:** the daemon's Graph scan for the *owner's* upcoming meetings is dumped to fs
(`out/calendar-events.txt`, `out/n.txt`) and the frontend calendar/schedule screens read those
files directly (`frontend/src/lib/calendar.ts`, `calendar-board.tsx`). No PG table.

**Why deferred:** this is the owner's personal auto-join schedule. The commercialized product
replaces "one daemon scrapes my Graph calendar" with per-user meeting ingestion (see
`multi-user-architecture.md` §5 jobs/scheduling), so this fs dump has no commercial future.

**Eventual (owner-only convenience):** daemon `GET /calendar` → `{ events, asOf }` (mirrors the
`/status` live-state pattern), frontend polls a proxy; drop the fs dump. Or persist in a
`meetings` table if the owner ever wants history. No urgency.

## Gap 2 — Mapping candidates — PERSONAL, deferred

**What:** the mapping UI's "candidate meeting titles" list. In `DB_READS=1` mode
`frontend/src/lib/db.ts mappingSnap()` returns `candidates: []` (hardcoded empty) — a regression
vs the fs mode that derives candidates from `out/n.txt`. `folders` is fine (from `courses()`).

**Why deferred:** meeting-title → course mapping is owner-personal (the owner's Teams titles).
Commercial users map their own meeting sources per-user; no shared `n.txt` equivalent.

**Eventual:** source candidates from the same meeting-titles endpoint as Gap 1 (or daemon
`GET /mapping` returning `{ mapping, folders, candidates }`), remove the `n.txt` fs read, and
delete the `candidates: []` stub. Fix when the owner wants the mapping manager back to parity.

## Gap 3 — Materials: one source of truth — COMMERCIAL, in scope

**Principle (from `postgres-migration.md` end-state data planes + `storage-backends.md`):**
material **bytes** stay out of Postgres — fs today, per-user cloud storage later. The platform
holds **metadata + pointers + embeddings** so listing and search work regardless of where the
bytes live.

**Current state (split-brain + lag):**
- `documents` + `document_chunks` (pgvector) in PG are already what semantic search runs on.
- The materials *list* reads the fs `materials.json` manifest (`listMaterials()`), not `documents`.
- `registerMaterial` (upload) writes the fs manifest only; `documents`/chunks catch up only on
  the periodic embed pass (`ingest-embed.ts`). delete/rename already sync `documents`
  (`forgetDocumentRows`/`moveDocumentRows`) — the insert/embed direction is missing.

**Requirements:**
1. **Uploads auto-embed.** On material upload/overwrite, immediately: upsert the `documents`
   row, chunk the extracted text, and write `document_chunks` + embeddings — no waiting for the
   periodic pass. Upload → searchable immediately; no split-brain.
2. **`listMaterials()` reads `documents`** (DB-primary); fs walk remains as fallback for
   no-DB / pre-import only.

**Out of scope / stays fs by design:** material bytes, docindex `.index/` page-text/page-PNG
caches (rebuildable), `materials.json` (becomes derived/legacy once `documents` is authoritative).

**Open question:** per-user cloud material storage later needs a `storage_uri` on `documents`
(mirroring `session_artifacts.storage_uri`) — additive column, no change now.

## Gap 4 — Avatar: store in `users`, not the provider API — COMMERCIAL, in scope

*Added after Gap 3 landed (listMaterials reads `documents`; uploads auto-embed). Not a
Phase-3 fs leftover — an identity-coupling cleanup tracked here because it's the same
one-source-of-truth principle: identity-adjacent data the app needs should live in the app's
DB, not behind the auth provider's API.*

**What:** `/api/me/avatar` proxies Authentik's core API v3 (`/api/v3/core/users/{uid}/`) with
a service token + `AUTHENTIK_API_URL` env. That is the app's only provider-API call and the
last blocker (besides header names) to swapping the forward-auth provider later
(`authentik-federation.md` §5, Phase 2 swap optionality).

**Why:** with the avatar cached in `users`, a provider swap loses nothing — no token, no
provider URL scheme, no migration. The JWT `picture` claim path (`auth.ts`) stays as the
*sync source* only.

**Requirements:**
1. **Schema** (additive): `users.avatar bytea`, `users.avatar_mime text`,
   `users.avatar_synced_at timestamptz`. Avatars are KB-scale (authentik generated =
   data-URI SVGs; uploads small), so `bytea` in PG is fine — the bytes-out-of-PG principle
   (Gap 3) was for video/document scale.
2. **Lazy sync:** on `/api/me` (first authenticated load), serve from DB; if null or
   `avatar_synced_at` older than N days, fetch once from the `picture` claim (URL → fetch
   with timeout; data URI → decode directly) and upsert. Never write on every `getAuthUser()`
   call. Optional explicit refresh action on `/settings`.
3. **Serving:** `/api/me/avatar` becomes a DB read + long-cache headers; drop the service
   token, `AUTHENTIK_API_URL`, and the v3 proxy. Keep UI initials fallback for null.
4. **Hardening:** cap blob size (~256KB) and claim-URL length; timeout the fetch so a hostile
   `picture` can't bloat rows or hang the request.

**Out of scope:** full provider-adapter rewiring (`AUTH_PROVIDER` + `parseIdentity` interface) —
decide later; Gap 4 makes it strictly optional. LOGOUT_URL env-ification is separate and
small.
