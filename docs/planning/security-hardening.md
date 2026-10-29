# Security hardening — auth/tenancy findings + fix plan

Status: **AUDITED 2026-10-29** (6 parallel read-only audits); fixes in progress. Findings are the
consolidated output of the trust-boundary, frontend-A/B/C, bearer/media, and daemon/db audits.

## Root cause
The app is a single-user design with a PARTIAL multi-user migration. Phase 1/2 owner-scoped
sessions/deadlines/checklists/chat/avatars, but **courses, materials, mapping, settings, search,
media, and the daemon's own auth were never migrated**. On top of that, identity is header-based
and fail-open.

## Shared contract for the fixes (READ THIS — the fix agents implement against it)
1. **Fail-closed identity**: an unauthenticated or spoofed request gets **401**, never the seed
   user's data. `SYSTEM_OWNER` remains ONLY for ownerless internal jobs (`curOwner()` on the
   daemon already covers those). No `?? SYSTEM_OWNER` on a user-facing route.
2. **Internal hop (frontend→daemon) is authenticated with a shared secret**: `daemonUserHeaders()`
   sets `X-Auto-School-User: <sub>` AND `X-Internal-Auth: <HMAC-SHA256(EDGE_SECRET, sub)>`.
   Daemon `resolveRequestOwner` verifies the HMAC and 401s on absent/mismatch — never falls back
   to seed OWNER. `x-owner-uuid`/`SMOKE_OWNER_UUID` impersonation is removed.
3. **EDGE_SECRET is actually set** in `auto-school-env` and required (non-`optional`) in the
   platform manifest, and the `auto-school-edge-marker` middleware is chained in the ingress so
   `middleware.ts` strips client-supplied `x-authentik-*`. Must be ONE atomic change (secret +
   marker + middleware strip), else enabling the strip downgrades everyone to seed.
4. **Tenancy for courses/materials/mapping/search/media**: owner-scoped reads/writes; `safeSlug()`
   validation on every `/courses/*` handler; `doc?path=` sanitized (no arbitrary file read).

## Priority order
- **P0 (root cause)** — fail-closed identity + EDGE_SECRET chain + daemon HMAC hop.
- **P1 (concrete RCE-grade vulns)** — `doc?path=` arbitrary read (→ settings.json API keys),
  slug traversal (`rm -rf`/read/write outside DATA_DIR), courses/materials IDOR.
- **P2 (cross-tenant data)** — `vectorSearch`/`keywordSearch`/`listCourses`/`listMappings`/
  `mappingSnap` owner filter; mapping upsert/delete owner-scoped; media route owner gate;
  `/api/settings`/`/segments`/`/session`(fs)/`/session/move`(fs) owner-scoped or admin-only.
- **P3 (bearer)** — per-user ingest tokens bound to `users.id` (drop shared global token's
  owner-in-body surface); heartbeat row MERGE (no replace/endpoint poisoning) + endpoint
  private-range block.
- **P4 (harden)** — NetworkPolicy, `timingSafeEqual` on daemon compare, deadline_parts over-fetch,
  `/status` global-mirror leak, study-sheet/lexicon cross-owner metadata.

## Fix wave split (disjoint files)
- **A — trust boundary** (frontend): `frontend/src/lib/{owner,auth,avatar}.ts`,
  `frontend/src/middleware.ts`, all user-facing frontend routes (mechanical `requireUser()` 401),
  `deploy/k8s/{auto-school-platform,auto-school-ingress,authentik-edge}.yaml`.
- **B — daemon + fs tenancy**: `src/daemon.ts` (resolveRequestOwner HMAC, safeSlug on all
  `/courses/*` handlers, doc/material/session/segments fs scoping), `src/pipeline/{docindex,materials}.ts`,
  `src/paths.ts`.
- **C — data layer owner scoping**: `src/db/{reader,writes,state}.ts`,
  `src/db/queries/{courses,sessions,notes}.ts`, `frontend/src/lib/db.ts`.
- **D — bearer + heartbeat** (after A/B/C): `frontend/src/app/api/{ingest,ingest/session,recorder/heartbeat,media/[...path]}/route.ts`,
  `src/db/recorders.ts`.
- **E — verifier** (independent re-audit of the whole fix).
