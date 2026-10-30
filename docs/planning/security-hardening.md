# Security hardening — auth/tenancy findings + fix plan

Status: **DEPLOYED 2026-10-29** — waves A–E merged (`main` 3d80ffe, tag
`security-hardening-code-complete-2026-10-29`), re-audited (FIX-LIST closed by wave E), and applied
to prod via the atomic marker + daemon-HMAC chain. Findings are the consolidated output of the
trust-boundary, frontend-A/B/C, bearer/media, and daemon/db audits.

## Deploy log (APPLIED 2026-10-29)
Atomic order: **secret → marker → ingress → rollout**. Do NOT reorder — new pods 401 without the
marker, and `CreateContainerConfigError` without the key.
1. `EDGE_SECRET` added to `auto-school-env` (`openssl rand -hex 32`, 64 hex chars; the secret now
   has 25 keys). *Pre-split name — the same value was later carried under `EDGE_MARKER` +
   `INTERNAL_HMAC_KEY` (see the follow-up note below).*
2. Applied ONLY the `auto-school-edge-marker` doc from `deploy/k8s/authentik-edge.yaml`, rendered
   with the same value. **Do NOT whole-file-apply that manifest** — its first doc re-declares the
   live `authentik-forwardauth` (which points at `authentik-server.authentik.svc.cluster.local` with
   an explicit header list) and would clobber it.
3. `kubectl apply -f deploy/k8s/auto-school-ingress.yaml` (adds the two priority-100 bearer routes
   + chains `auto-school-edge-marker` after `authentik-forwardauth`).
4. `kubectl apply -f auto-school-recorder.yaml -f auto-school-platform.yaml` → both rolled 1/1.

Verified: direct-pod forged `X-Authentik-*` → 401; daemon hop bare → 401 / HMAC-signed →
authenticated; recorder heartbeat round-trip fresh (~27s); marker == EDGE_SECRET byte-identical;
recorder rehydrated 50 sessions with no EDGE_SECRET/HMAC errors.

**⚠ Rotation trap:** the marker is a *rendered* Traefik CRD — a later `EDGE_MARKER` rotation silently
desyncs (marker still holds the old value) until you re-render + re-apply the marker. Put
`render + apply auto-school-edge-marker` into any key-rotation runbook.

**⚠ Secret double-duty (RESOLVED — split LANDED):** the value used to be BOTH the plaintext
`X-Edge-Secret` marker (liftable from header-logging proxies) and the internal daemon-hop HMAC key.
The two roles now have separate env vars and separate Secret keys: **`EDGE_MARKER`** = the marker,
**`INTERNAL_HMAC_KEY`** = the HMAC-SHA256 key for `X-Internal-Auth`. Rotate them independently —
the marker still needs the render+apply step below, the HMAC key rolls with the two pods.

**Code-landed follow-ups (not yet deployed):** marker/HMAC split (`EDGE_MARKER` + `INTERNAL_HMAC_KEY`
Secret keys, platform gets both, recorder gets the HMAC key only) and the daemon `/status`
`seedOwnerOnly()` gate — `/status` no longer mirrors the recorder owner's state/schedule/snapshot to
non-seed members (401). Deploy must be atomic: create BOTH new Secret keys, re-render the edge marker
from `EDGE_MARKER`, then roll platform + recorder together (old pods don't know the new names).

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
   sets `X-Auto-School-User: <sub>` AND `X-Internal-Auth: <HMAC-SHA256(INTERNAL_HMAC_KEY, sub)>`.
   Daemon `resolveRequestOwner` verifies the HMAC and 401s on absent/mismatch — never falls back
   to seed OWNER. `x-owner-uuid`/`SMOKE_OWNER_UUID` impersonation is removed.
3. **`EDGE_MARKER` + `INTERNAL_HMAC_KEY` are actually set** in `auto-school-env` and required
   (non-`optional`) in the platform manifest, and the `auto-school-edge-marker` middleware is
   chained in the ingress so `middleware.ts` strips client-supplied `x-authentik-*`. The daemon
   pod gets `INTERNAL_HMAC_KEY` only (it verifies the HMAC, never the marker). Must be ONE atomic
   change (secret + marker + middleware strip), else enabling the strip downgrades everyone to seed.
   `/status` (daemon) carries a `seedOwnerOnly()` gate: its state/schedule/snapshot mirror is the
   recorder owner's, so non-seed members get 401.
4. **Tenancy for courses/materials/mapping/search/media**: owner-scoped reads/writes; `safeSlug()`
   validation on every `/courses/*` handler; `doc?path=` sanitized (no arbitrary file read).

## Priority order
- **P0 (root cause)** — fail-closed identity + `EDGE_MARKER` chain + `INTERNAL_HMAC_KEY` daemon hop.
- **P1 (concrete RCE-grade vulns)** — `doc?path=` arbitrary read (→ settings.json API keys),
  slug traversal (`rm -rf`/read/write outside DATA_DIR), courses/materials IDOR.
- **P2 (cross-tenant data)** — `vectorSearch`/`keywordSearch`/`listCourses`/`listMappings`/
  `mappingSnap` owner filter; mapping upsert/delete owner-scoped; media route owner gate;
  `/api/settings`/`/segments`/`/session`(fs)/`/session/move`(fs) owner-scoped or admin-only.
- **P3 (bearer)** — per-user ingest tokens bound to `users.id` (drop shared global token's
  owner-in-body surface); heartbeat row MERGE (no replace/endpoint poisoning) + endpoint
  private-range block.
  - **wave D landed (v1)** — `INGEST_TOKEN`/`RECORDER_TOKEN` stay a single global secret, but
    are now **bound to the seed owner**: `/api/ingest/session` resolves `body.owner` → `users.id`
    and 401s unless it equals `SYSTEM_OWNER`; heartbeat requires `owner`+`mode`+`endpoint`+
    `capabilities` (400 when partial, `name` ≤64) so a row can never be partially nulled, and
    `src/db/recorders.ts` merges (`coalesce`) instead of replacing; the endpoint must parse as
    http(s) and its host must not be loopback/RFC1918/link-local/metadata/ULA/link-local-v6
    (the only loopback exception is the co-located daemon `localhost:7800`, which itself
    HMAC-gates every hop). `RECORDER_TOKEN` has no owner-in-body bind because the registry row
    is already keyed `(owner_user_id, name)` and the owner must resolve via `users.authentik_sub`.
  - **P3 remainder (multi-client future)**: per-user ingest tokens (one row per client, token
    hash bound to `users.id`, owner taken from the TOKEN instead of the body), per-user recorder
    tokens, and DNS-resolved (not just literal) SSRF checks for the recorder endpoint.
  - **media owner gate landed (wave D)** — the daemon's root-mounted media route (GET/HEAD
    `recordings|out|courses`) now requires the seed owner via `seedOwnerOnly()` → 401 otherwise;
    the platform's `/api/media/*` recorder-proxy hop is signed with `daemonUserHeaders()` (it was
    unsigned after wave B, so every proxied stream silently fell back to fs). Per-owner fs dirs
    remain the documented follow-up.
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
