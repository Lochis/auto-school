# Recorder split — daemon-less platform, personal recorder stays live

Status: **5a steps 1-2 LANDED** (`5e40545`); **step 3 (manifest cutover) APPLIED 2026-10-29** —
live is now platform + recorder (split pods), enabled by the 5b-1 recorder media route
(`ingestion-api.md` §1/§4); `/api/me` reports `recorder.attached: true` and media serves through
the recorder. Applied log: §5.1. Plan of record below (2026-10-21). Answers: how does the frontend
become daemon-less (hosted-platform.md
§5 item 5) while the owner's recording daemon keeps working? Short answer: **no new
microservices — split the pod into two Deployments (platform vs recorder) and introduce a
per-owner recorder registry with heartbeats.** The daemon already *is* a microservice; the work
is removing the frontend's assumption that it lives at `localhost:7800` in the same pod.

---

## 1. Why not decompose the daemon itself

Splitting the daemon into recorder/pipeline/API services buys nothing: it is a single-user
appliance (auto-attend bot + ffmpeg + Gemini pipeline + :7800 controller) whose parts share
lifecycle (browser session ↔ recording ↔ consolidation), state, and one RWO PVC. The scale
axis of the hosted product is *users on the platform*, not *load on one recorder*. The only
boundary that matters is recorder ↔ platform.

## 2. Target topology

```
┌─ platform Deployment (schedulable anywhere) ─┐   ┌─ recorder Deployment (nodeSelector
│ Next.js frontend  (no /data mount)           │   │ k3s-worker-02, keeps RWO PVC)
│ PG via auto-school-pg svc                    │   │ daemon :7800 (cluster-only Service,
│ daemon-proxy routes → registry lookup        │──▶│ Xvfb/Chromium/Pulse/ffmpeg,
└──────────────────────────────────────────────┘   │ writes PG directly, system-OWNER
        ▲                                          │ for scheduled jobs)
        └─ heartbeat: recorder POSTs /api/recorder/heartbeat ──┘
```

- **Platform pod**: frontend + nothing else. Loses the ro `/data` mount, loses
  `BACKEND_URL=localhost:7800`. Serves every user; daemon-less by default.
- **Recorder pod**: today's daemon container verbatim, its own Deployment + Service
  (`auto-school-recorder:7800`, **cluster-internal only — never an Ingress route**; the
  frontend proxies). Keeps the PVC, `user-data/`, node pin. Keeps writing PG directly — it is
  our trusted pod, not a stranger's client; the ingestion API (hosted-platform.md §3) is for
  *external* Electron clients and can come later without touching this split.
- Postgres unchanged (shared, already owner-scoped).

> **Boundary note (2026-10-29).** The recorder pod is today's daemon **verbatim for now**: it
> still does capture → Gemini transcribe → notes → DB writes locally, because it owned
> everything historically. `hosted-platform.md` §1.6 shrinks its irreducible job to
> **capture + submit**; its direct-PG writes are the **trusted fast-path** of the same
> ingestion contract (an Electron client uses the API over HTTPS instead). This doc only
> moves the *process boundary*; the responsibility shrink is 5b work.

## 3. The recorder registry (the one new platform table)

```sql
CREATE TABLE IF NOT EXISTS recorders (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL DEFAULT 'personal',
  mode          text NOT NULL DEFAULT 'inbound'   -- 'inbound' (platform→svc URL) | 'poll' (Electron)
  endpoint      text,                             -- http://auto-school-recorder:7800 (inbound mode)
  last_seen     timestamptz,
  capabilities  jsonb NOT NULL DEFAULT '{}',      -- {liveStatus, joinControl, mediaServe, ...}
  PRIMARY KEY (owner_user_id, name)
);
```

- **Heartbeat**: the daemon already publishes status; add a periodic
  `POST /api/recorder/heartbeat` (authentik-token auth, or a recorder token) carrying
  capabilities + a monotonic status digest. `last_seen` staleness (>60s) = recorder offline.
- **`mode` matters for Electron later**: a laptop recorder is behind NAT — the platform can't
  reach it, so `poll` recorders pull commands (join/leave) from the platform instead of
  serving them. The personal pod is `inbound` (same cluster, direct proxy). The registry
  models both from day one; only `inbound` is implemented in this phase.
- Frontend `lib/backend.ts`: `BASE` becomes `resolveRecorder(ownerId)` — registry row (fresh
  `last_seen`) → endpoint; no row/stale → daemon-less mode. `BACKEND_URL` stays as a
  transitional fallback (one env, no registry) for the pre-split deploy.

## 4. Frontend degradation map (what daemon-less users see)

| Surface | Today | Daemon-less |
| --- | --- | --- |
| Courses/sessions/notes/deadlines/checklists/chat/search | PG (DB_READS=1) | unchanged — this is the hosted product |
| Status board / live recording state | daemon `/status` poll | hidden ("no recorder attached"); owner sees it via their recorder endpoint |
| Join/leave/autopilot/transcribe/ingest controls | daemon proxy | hidden/disabled (404-shape, not errors) |
| Media playback (recordings, segments) | fs via ro `/data` mount | proxy to the owner's recorder (`mediaServe` capability); presigned user-cloud later (storage backends, README item 7) |
| Settings | daemon `/settings` | platform-side: user overlay direct-to-PG; recorder knobs only when a recorder is attached |
| Calendar/autopilot target | daemon fs dump (`out/`) | recorder-only; stays behind the proxy |

Degradation is per-owner and dynamic: `GET /api/me` grows `recorder: {attached, mode}` so the
UI can render both worlds from one codebase (only those two fields are returned — staleness is
collapsed into `attached` server-side; there is no `staleAfterMs` in the payload). (This is also
exactly the seam the Electron shell reuses — "recorder attached" becomes "recorder is me,
local".)

## 5. Migration order (each step deploys independently)

> **APPLIED 2026-10-29 — step 3 (manifest cutover).** Live is platform + recorder; the exact
> sequence, evidence and the kubectl gotcha are in the applied log at the end of §5.1.
>
> **Deploy prerequisites (verified in review, 2026-10-21):** before cutover, apply the
> `recorders` DDL to Postgres (else heartbeats 500 and the registry silently never
> populates — masked by daemon-less fallback) and set `RECORDER_TOKEN` in the
> `auto-school-env` secret (else heartbeats 401 forever). The manifest switch is ATOMIC but
> **ordered**: retire the single-pod Deployment FIRST, then apply platform + recorder
> together. Longhorn `RWO` is enforced per *node*, and both pods are pinned/placed on
> `k3s-worker-02`, so a recorder pod would happily mount the same volume while the old pod
> still runs — two daemons, one PVC (profile lock fight, double joins). Runbook: §5.1.
>
> **Known follow-ups for 5b:** deadline/checklist *mutations* still proxy to the daemon
> (toggles, date edits — not just generate/rebuild), now visibly gated in the UI; moving
> them platform-side is 5b work alongside the ingestion API.
>
> **Env knobs for the split (undocumented until now, see `src/recorder-heartbeat.ts` and
> `deploy/k8s/auto-school-recorder.yaml`):** `PLATFORM_URL` — where the recorder posts
> heartbeats (default `http://localhost:3000`, same-pod transitional; set to the platform
> Service, e.g. `http://auto-school:80`, on the recorder Deployment) and `RECORDER_ENDPOINT` —
> the controller base URL the recorder *registers* in its registry row (default
> `http://localhost:7800`; set to `http://auto-school-recorder:7800`). Both live on the
> recorder pod, not the platform.
> The media prerequisite is now met: the 5b-1 daemon media route landed 2026-10-29 and the
> heartbeat posts `mediaServe: true` (`ingestion-api.md` §1/§4).

1. **Registry + heartbeat** (additive; daemon posts it; frontend ignores it) — zero risk.
2. **Frontend proxy indirection**: `lib/backend.ts` resolveRecorder() with `BACKEND_URL`
   fallback; degradation UI behind `recorder.attached`. Still same pod. Deploy, verify parity.
3. **Pod split** — **APPLIED 2026-10-29** (§5.1 applied log): recorder Deployment (+Service)
   with today's daemon spec + PVC; platform Deployment keeps frontend; drop ro `/data` mount +
   `BACKEND_URL` from platform; media route flips to recorder proxy. Node unpinned for platform.
4. **Cleanup**: retire the two-container manifest (`kubectl delete deploy auto-school` only —
   never `kubectl delete -f`, see §5.1), `deploy/k8s/auto-school.yaml` is superseded by
   `auto-school-platform.yaml` + `auto-school-recorder.yaml`; smoke suite aims at the
   recorder Service.
5. **(later, with ingestion API)** `mode='poll'` recorders — command pull + status push for
   Electron clients; nothing above changes.

### 5.1 Cutover runbook — manifest switch (5a step 3)

Verified READY 2026-10-29 against `main` @ `aee53b6` + the live cluster (see the table at the
end of this section). **APPLIED 2026-10-29** — the actual sequence and evidence are in the
applied log at the end of this section; the steps below stay the canonical run + rollback.

**Preflight (read-only).** Any failure here = stop, do not cut over.

- `recorders` DDL live: `select to_regclass('public.recorders')` → non-null (state 2026-10-29:
  present, 0 rows).
- PVC: `auto-school-data` Bound, 60Gi, `longhorn`, RWO, attached on `k3s-worker-02`.
- Owner claimable: the daemon heartbeats as `src/db/writes.ts` `OWNER`
  (`…0001`/`lochis`); its `users.authentik_sub` must be non-null, else
  `resolveOwnerSub()` returns null and **no heartbeat is ever sent**
  (`src/recorder-heartbeat.ts:27-40`). State 2026-10-29: set.
- **No class in flight.** `kubectl -n auto-school exec deploy/auto-school -c auto-school -- \
  curl -s localhost:7800/status` shows no active recording, and
  `select count(*) from sessions where stage in
  ('recording','remuxing','transcribing','noting','consolidating')` = 0 (there is **no**
  `recordings` table — the `stage` column lives on `sessions`, `src/db/ddl.sql:55-75`).
  Never cut over mid-class
  (the old pod consolidates on SIGTERM, but the recorder cannot resume its capture).
- Capture the rollback artifact:
  `kubectl -n auto-school get deploy auto-school -o yaml > /tmp/auto-school-old-deploy.yaml`.

**(1) Add the two tokens — `stringData` merge, existing keys preserved.**

```sh
REC=$(openssl rand -hex 32); ING=$(openssl rand -hex 32)
kubectl -n auto-school patch secret auto-school-env --type merge \
  -p "{\"stringData\":{\"RECORDER_TOKEN\":\"$REC\",\"INGEST_TOKEN\":\"$ING\"}}"
# verify: 23 keys (21 existing + 2), both new ones present, nothing else lost
kubectl -n auto-school get secret auto-school-env -o json | \
  jq '.data | keys | length, (index("RECORDER_TOKEN"), index("INGEST_TOKEN"))'
```

`--type merge` merges `stringData` key-by-key (`data` is untouched because it is not in the
patch), so the 21 existing keys (`GEMINI_API_KEY`, `TEAMS_*`, `TOTP_SECRET`, `GLM_*`, …) survive.
Both consumers read them `optional: true`, so a missing key does not block pod start — it fails
closed instead (`RECORDER_TOKEN` unset → heartbeat 401,
`frontend/src/app/api/recorder/heartbeat/route.ts:12-22`; `INGEST_TOKEN` unset → ingest 401,
`frontend/src/app/api/ingest/session/route.ts:36-38`). Patch **before** step 2 so the new pods
pick the env up at creation (no restart needed).

**kubectl gotcha (hit live on 2026-10-29):** on this kubectl version `--patch-file=-` does **not**
read stdin — the command returns success and applies nothing. Write the patch (base64-decoded) to
a file on the node and pass `--patch-file <file>`, then verify the key count.

**(2) Retire the single-pod Deployment FIRST.**

```sh
kubectl -n auto-school delete deploy auto-school --cascade=background
kubectl -n auto-school wait --for=delete pod -l app=auto-school --timeout=200s
```

Why first: the old pod sits on `k3s-worker-02` and the recorder is pinned to the same node, so a
newly created recorder pod would mount the same `RWO` Longhorn volume while the old daemon is
still live. The old manifest's *effective* grace period is 120s (it sets
`terminationGracePeriodSeconds` twice — 300 at `auto-school.yaml:96`, 120 at `:192`; YAML
last-wins), so the wait can legitimately take ~2 min while it stops the recorder and consolidates.

**(3) Apply both new manifests together.**

```sh
kubectl apply -f deploy/k8s/auto-school-platform.yaml -f deploy/k8s/auto-school-recorder.yaml
kubectl -n auto-school rollout status deploy/auto-school-platform --timeout=180s
kubectl -n auto-school rollout status deploy/auto-school-recorder --timeout=600s  # first pull ~2.9GB
```

**NEVER** `kubectl delete -f deploy/k8s/auto-school.yaml` (the header comment of the old and the
platform manifest still suggests it): that deletes the `auto-school-data` PVC — Longhorn reclaims
the volume and the recordings/notes are gone — plus the Namespace and both Services. Delete by
object *name* only. Same care in reverse: `auto-school-recorder.yaml` re-declares the PVC (same
name/spec, apply = no-op), so `kubectl delete -f` on it would take the data with it.

**(4) Repoint the debug Service (else the port-forward target breaks).**

```sh
kubectl -n auto-school patch svc auto-school-ctrl -p '{"spec":{"selector":{"app":"auto-school-recorder"}}}'
```

`auto-school-ctrl` (7800) still selects `app=auto-school`; after the split that is the platform
pod, which has no `ctrl` port. `kubectl delete deploy` does not remove the Service.

**(5) Verify.**

```sh
# pods: platform Ready anywhere, recorder 1/1 Running on k3s-worker-02
kubectl -n auto-school get pods -o wide
# the frontend Service must endpoint ONLY the platform pod (no recorder IP)
kubectl -n auto-school get endpoints auto-school
# registry row: one fresh inbound recorder advertising mediaServe
kubectl -n auto-school exec deploy/auto-school-pg -- \
  psql -U autoschool -d autoschool -c \
  "select owner_user_id,name,mode,endpoint,last_seen,capabilities from recorders"
#   → endpoint http://auto-school-recorder:7800, capabilities.mediaServe = true, last_seen < 60s
# no auth failures either way
kubectl -n auto-school logs deploy/auto-school-platform --tail 100 | grep -iE 'heartbeat|unauthorized'
kubectl -n auto-school logs deploy/auto-school-recorder -c auto-school --tail 100 | grep -i heartbeat
```

Attachment + media (the platform holds no `/data` mount, so every byte must come from the
recorder — a 404 here means the proxy path is broken, not a missing file):

```sh
kubectl -n auto-school port-forward svc/auto-school 3000:80 &
UID=928d2b96d602112681a2168170744b42feee4258fec61b9b155cb122b038413a   # lochis
curl -s -H "X-authentik-uid: $UID" localhost:3000/api/me | jq '.recorder'
#   → {"attached":true,"mode":"inbound"}
curl -s -o /dev/null -w '%{http_code}\n' "localhost:3000/api/media/<recording>.mp3"              # 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-1023' \
  "localhost:3000/api/media/<recording>.mp3"                                                     # 206
```

Then through the edge: `https://school.vanderloch.com` loads, the status board shows the recorder
attached, and `/api/me` in the browser reports `recorder.attached: true`. (The port-forward curl
works because `EDGE_SECRET` is not set in `auto-school-env`, so `src/middleware.ts` does not strip
`X-authentik-*` on a direct hit. If `EDGE_SECRET` is ever added, verify in the browser instead —
trusting the header path is `TRUST_AUTHENTIK_HEADERS=1` on both pods either way.)

**(6) Rollback — re-apply the old Deployment only.**

```sh
kubectl -n auto-school scale deploy/auto-school-recorder --replicas=0   # free the RWO PVC first
kubectl -n auto-school wait --for=delete pod -l app=auto-school-recorder --timeout=200s
kubectl apply -f /tmp/auto-school-old-deploy.yaml                      # object captured in preflight
kubectl -n auto-school rollout status deploy/auto-school --timeout=600s
kubectl -n auto-school scale deploy/auto-school-platform --replicas=0   # one frontend on the Service
```

Roll back before the recorder has taken a write whenever possible; after that both daemons see the
same PVC state, which is fine (single daemon at a time) but the recorder's in-flight class is lost.
The old Deployment is safe to re-apply — it declares only the Deployment, not the PVC/Service; the
PVC, Namespace and both Services are untouched by the whole cutover.

**Readiness (verified 2026-10-29, `main` @ `aee53b6`):**

| # | Check | Evidence | Result |
| --- | --- | --- | --- |
| 1 | PVC shared, not duplicated; platform mounts no data | `auto-school-recorder.yaml:101` `claimName: auto-school-data`; `:21-28` same PVC (same 60Gi/longhorn spec ⇒ apply is a no-op); platform manifest has no `volumes:`/`volumeMounts` (`AUTO_SCHOOL_DATA` is a dead path prefix, `auto-school-platform.yaml:57`) | PASS |
| 2 | Recorder node pin | `auto-school-recorder.yaml:51` `nodeSelector kubernetes.io/hostname: k3s-worker-02` | PASS |
| 3 | Services/ingress split | platform `Service/auto-school` selects `app: auto-school` (`:98`) = platform pod only; recorder pod is `app: auto-school-recorder` (`:48`), its Service `:111` is in no IngressRoute; `auto-school-ingress.yaml` M2M + catch-all → `auto-school:80` | PASS |
| 3b | Media proxy path | `/api/media/[...path]` → `getActiveRecorder(owner)` → `proxyRecorderMedia(endpoint, …)` (`route.ts:93-104`) → recorder serves at **root, no `/media` prefix** (`src/daemon.ts:2532-2540`) | PASS |
| 4 | Tokens read from `auto-school-env`, fail closed | `auto-school-platform.yaml:66,71`; `auto-school-recorder.yaml:74` (`optional: true`) + `envFrom` whole secret `:77`; unset ⇒ 401 in both handlers | PASS — live secret patched 2026-10-29 (21→23 keys), step 1 applied log |
| 5 | Image refs | `auto-school-platform.yaml:54` frontend:latest; `auto-school-recorder.yaml:62` auto-school:latest | PASS |
| 6 | recorder envs + code wiring | `PLATFORM_URL=http://auto-school:80` (`:72`, read at `src/recorder-heartbeat.ts:15,19`), `RECORDER_ENDPOINT=http://auto-school-recorder:7800` (`:73`, read at `:16,61`); **no `MEDIA_SERVE` env exists** — `mediaServe` is hard-coded true in the heartbeat (`recorder-heartbeat.ts:69`) and gated on the registry capability, not env | PASS (task premise stale) |
| 7 | Leftover `Service/auto-school-ctrl` | selected `app=auto-school` (live `10.43.188.193`) ⇒ would point at the daemon-less platform pod after cutover | RESOLVED — repointed to `app=auto-school-recorder`, step 4 applied log |

No blocker remains in the manifests themselves. The only hard prerequisite is the token patch
(step 1); the ordering in step 2 is what keeps the cutover safe. Both were done as prescribed on
2026-10-29.

**APPLIED LOG — 2026-10-29** (`main` @ `6b9aa16`, worktree `docs-cutover-1`). Executed live and
healthy, in this order:

- **(a) Tokens — `stringData` merge on `auto-school-env`.** `RECORDER_TOKEN` + `INGEST_TOKEN`
  added via `--type merge`; the secret went **21 → 23 keys** with every pre-existing key preserved
  (count + key-presence check). *kubectl gotcha:* `--patch-file=-` does **not** read stdin on this
  version (exit 0, no change); the patch JSON was base64-decoded to a file on the node and applied
  with `--patch-file <file>`.
- **(b) Retired the single-pod by name.** `kubectl delete deploy auto-school
  --cascade=background` + `kubectl wait --for=delete pod -l app=auto-school` — the old pod was
  fully unmounted (RWO PVC released) **before** anything new was applied. No `-f` deletes.
- **(c) Applied both manifests.** `kubectl apply -f auto-school-platform.yaml -f
  auto-school-recorder.yaml`. The PVC reporting **"configured" was benign**: the manifest already
  declares 60Gi and the live claim stayed `Bound` at 60Gi (no resize, no rebind, no data motion).
- **(d) Repointed the debug Service.** `svc/auto-school-ctrl` selector → `app:
  auto-school-recorder` (it would otherwise have pointed at the daemon-less platform pod).
- **(e) Verified live.** Both pods `Running` on `k3s-worker-02`; one registry row `mode=inbound`,
  `endpoint http://auto-school-recorder:7800`, `capabilities {mediaServe: true, joinControl:
  true}`, `last_seen` fresh; `/api/me` → `{recorder: {attached: true, mode: "inbound"}}`; media
  `GET /api/media/…` → **200** (221 MB `.webm` streamed through the recorder proxy).
- **(f) Cleared a stuck `joinPaused`.** It was persisted `true` in `app_settings` from an earlier
  pause; `POST /pause` against the recorder → `{joinPaused: false, "auto-join resumed"}`.

Rollback is unchanged (step 6): the `/tmp/auto-school-old-deploy.yaml` artifact captured in
preflight is still the way back.

## 6. Risks / open questions

- **PVC move**: recordings/notes/user-data stay on the daemon's PVC — no data motion, the
  daemon keeps the claim; only the frontend's ro mount goes away.
- **Scheduled jobs remain system-OWNER** — correct while the recorder is personal (it records
  *for* the owner's account). If a second inbound recorder ever appears, its jobs must carry
  that owner — the registry schema already anticipates it.
- **Status latency**: board refresh goes localhost→cluster-hop; negligible on-k8s.
- **The `/status` board is daemon-global today** (attendance, quotas) — per-owner views come
  free from Phase-1 owner scoping; keep the global singleton on the recorder itself.
- Open: does the frontend proxy recorder traffic *with* the user's X-Auto-School-User header
  (Phase 1 already does) — yes, unchanged; the daemon trusts it cluster-internally only.
