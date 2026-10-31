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

**Code-landed follow-ups (DEPLOYED 2026-10-30):** marker/HMAC split (`EDGE_MARKER` +
`INTERNAL_HMAC_KEY` Secret keys, platform gets both, recorder gets the HMAC key only) and the daemon
`/status` `seedOwnerOnly()` gate are now LIVE. Deploy method: added `EDGE_MARKER` (fresh) +
`INTERNAL_HMAC_KEY` (= the old `EDGE_SECRET` value, keeping the HMAC key stable so old/new pods
interop during the window) to `auto-school-env`; re-rendered `auto-school-edge-marker` to the new
`EDGE_MARKER`; patched the LIVE deployments surgically (NOT `kubectl apply`, which would have
re-pointed `svc auto-school` at a leftover legacy daemon — see drift note). Verified: spoof no/wrong
marker → 401, correct marker → 200, frontend→recorder HMAC hop 200, NetworkPolicy applied + hop
still 200. Tag `security-split-code-complete-2026-10-30`.

**⚠ Live drift (2026-10-30, fix before any manifest apply):** live frontend Deployment is
`auto-school-frontend` (label `app: auto-school-frontend`); repo manifest says `auto-school-platform`
(`app: auto-school`). The leftover `auto-school` daemon Deployment was **scaled to 0** (2026-10-30,
reversible via `kubectl -n auto-school scale deploy auto-school --replicas=1`); `svc auto-school-ctrl`
still selects it and now has no endpoints. See project memory for the full map.

**Recorder join-path fixups (2026-10-30, live-patched to match the manifest):** added `envFrom:
[auto-school-env, auto-school-pg]` back (live deployment had lost it — no Teams/TOTP/Graph creds) and
wired `BROWSER_CHANNEL` (secret) into env. Headful msedge launch verified in-pod under Xvfb;
heartbeat fresh. Root cause of the "chromium not found" join errors was ONLY the missing
`BROWSER_CHANNEL` env — Edge lives at `/opt/microsoft/msedge/msedge`, not `/ms-playwright`.

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
   sets `X-Auto-School-User: <sub>` AND `X-Internal-Auth:
   <HMAC-SHA256(INTERNAL_HMAC_KEY, sub.ts.nonce)>` plus plaintext `X-Internal-Ts` / `X-Internal-Nonce`
   companion headers (replay hardening 2026-10-31, see the section below).
   Daemon `resolveRequestOwner` verifies the HMAC and 401s on absent/mismatch/stale/replayed — never
   falls back to seed OWNER. `x-owner-uuid`/`SMOKE_OWNER_UUID` impersonation is removed.
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

## Internal-hop replay hardening (CODE-LANDED 2026-10-31 — re-audit finding CLOSED)
Re-audit finding: `X-Internal-Auth = hex(HMAC-SHA256(key, sub))` had no timestamp/nonce, so a
**captured header pair could be replayed against :7800 indefinitely**. NetworkPolicy (the port is
reachable only from the platform pod) mitigated but did not close it.

**New contract** (src/internal-auth.ts — shared by src/daemon.ts and mirrored in
frontend/src/lib/owner.ts + scripts/smoke.ts):
- Signed message is `sub + "." + ts + "." + nonce` (ts = epoch ms, nonce = 16 random bytes hex);
  ts/nonce travel as PLAINTEXT `X-Internal-Ts` / `X-Internal-Nonce` so the daemon reconstructs the
  message. Header objects must be minted per request (`daemonUserHeaders()` does; a reused header
  set 401s as a replayed nonce).
- Daemon verify order: format → ts freshness (**|now − ts| ≤ 5 min**; pods are TZ-synced via k8s) →
  HMAC (timingSafeEqual, length-checked) → nonce. A ts+nonce pair already seen is rejected; the
  in-memory seen-set carries a **6-minute TTL**, swept on insert (one entry per hop, stays tiny).
  Nonces are recorded only AFTER the HMAC passes (garbage can't poison the set). Every rejection →
  the same uniform 401 (no state oracle).
- The seen-set is **per-daemon-process** — fine for the single-recorder pod; horizontal scaling
  would need shared state (documented future follow-up).
- **Legacy fallback (rollout window ONLY, remove next release):** a request signing the old
  sub-only format is accepted iff BOTH companion headers are ABSENT (exactly one present → 401);
  the HMAC-over-sub check is unchanged, so legacy stays fail-closed. The daemon logs a
  rate-limited (once/10 min) deprecation warning per legacy verify. Both sides ship in the same
  images and roll in the same window, so the fallback exists only to make the interleaved rollout
  non-breaking.

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

## EDGE_SECRET retirement (APPLIED 2026-10-30)
Superseded by the `EDGE_MARKER` (edge marker) + `INTERNAL_HMAC_KEY` (daemon-hop HMAC) pair; the
old `EDGE_SECRET` value was carried verbatim into `INTERNAL_HMAC_KEY`, so deleting the key loses
nothing. **Nothing reads it**: `rg -n "EDGE_SECRET" src frontend/src deploy/k8s scripts/` is
empty. **APPLIED 2026-10-30**: key removed from `auto-school-env` via the runbook below;
post-checks passed — key gone, pods unaffected, `INTERNAL_HMAC_KEY` still 64-hex, HMAC hop 200,
and the full smoke suite passed **27/27** in the recorder pod afterwards (also validating the
owner-scope wave's owner-aware conflict targets end-to-end).

## Owner-scope wave (APPLIED 2026-10-30)
`deploy/sql/2026-10-30-owner-scope/` — expand (3 CONCURRENTLY unique indexes, all `indisvalid=t`)
→ deploy new images (`0c00ca2…`) → write-probe (3× `INSERT 0 1`, ROLLBACK, 0 residual) → contract
(dropped `courses_slug_key`, `meeting_mappings_match_title_key`,
`documents_course_id_kind_rel_path_key`; ANALYZE). Post-state: only PKs + the three owner-scoped
arbiters remain. The `src/pipeline/materials.ts` residual unscoped `courses` select is closed.

## ⚠ INCIDENT (2026-10-30): Terraform owns both Deployments — TWO reversion outages
Both `auto-school-frontend` and `auto-school-recorder` Deployments (ns `auto-school`) are owned
by the homelab's Terraform module `terraform/apps/modules/auto-school` in the **separate
`Lochis/kube` repo** (SSA manager `HashiCorp`; consolidated there 2026-10-30). Consequence:
**kubectl patches to those Deployments are NON-DURABLE — every `terraform apply` (Atlantis PR or
local) reverts the specs to the module's declared env.** This caused TWO outages on 2026-10-30:

- **18:23Z** — an apply reverted specs; restarted pods came up without
  `INTERNAL_HMAC_KEY`/`EDGE_MARKER`/`BROWSER_CHANNEL`/`envFrom`, the daemon logged
  `INTERNAL_HMAC_KEY is not set`, and the module is stale vs the security-split env
  (root cause: env added via kubectl patch after the split, never reflected in the module).
  Restored by hand: env re-patch + rollout.
- **19:07Z** — a second apply reverted again; heartbeat died 8.4h silent, valid logins 401'd,
  and the legacy `auto-school` daemon was **resurrected** (replicas 1) after being scaled to 0
  — the module still declares it. Restored by hand; heartbeat/auth verified green.

**Resolution (in flight)**: PR to the kube repo updating the module — `EDGE_MARKER` +
`INTERNAL_HMAC_KEY` on frontend; `INTERNAL_HMAC_KEY` + `BROWSER_CHANNEL` + `envFrom`
(`auto-school-env`, `auto-school-pg`) on recorder; legacy `auto-school` replicas 0; dead
`AUTHENTIK_API_*` envs removed — pending `atlantis apply`. **Durable changes go THERE (PR +
`atlantis apply`), never via kubectl patch.** Check ownership:
`kubectl -n auto-school get deploy <d> -o jsonpath='{.metadata.managedFields}'`.

**Rollback** = re-add the key with the `INTERNAL_HMAC_KEY` value (never read it from pod env —
pull it from the secret):
```sh
kubectl -n auto-school create secret generic auto-school-env \
  --from-literal=EDGE_SECRET="$(kubectl -n auto-school get secret auto-school-env -o jsonpath='{.data.INTERNAL_HMAC_KEY}' | base64 -d)" \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Runbook — delete the key
```sh
kubectl -n auto-school patch secret auto-school-env --type=json -p '[{"op":"remove","path":"/data/EDGE_SECRET"}]'
```

Post-checks:
- (a) key gone: `kubectl -n auto-school get secret auto-school-env -o jsonpath='{.data}' | grep -o EDGE_SECRET` → no output.
- (b) pods do **not** restart — a secret-data change triggers no rollout on its own; running
  pods keep the stale `EDGE_SECRET=` env var until their next restart. Harmless (nothing reads
  it); every pod started after the patch is leak-free.
- (c) daemon still healthy: `kubectl -n auto-school logs deploy/auto-school-recorder | grep 'INTERNAL_HMAC_KEY is not set'`
  → absent (that warning at `src/daemon.ts` only fires if the *live* key is missing).
- (d) frontend→recorder hop still signed+200: `curl -s -o /dev/null -w '%{http_code}\n' https://school.vanderloch.com/api/backend` → 200
  (`/api/backend` proxies to the daemon via `daemonUserHeaders()` HMAC).
