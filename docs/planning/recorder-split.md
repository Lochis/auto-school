# Recorder split — daemon-less platform, personal recorder stays live

Status: **5a steps 1-2 LANDED** (`5e40545`); **step 3 (manifest cutover) HELD** — the
single-pod is still live; unblocked 2026-10-29 by the 5b-1 recorder media route
(`ingestion-api.md` §1/§4). Plan of record below (2026-10-21). Answers: how does the frontend
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

> **Deploy prerequisites (verified in review, 2026-10-21):** before cutover, apply the
> `recorders` DDL to Postgres (else heartbeats 500 and the registry silently never
> populates — masked by daemon-less fallback) and set `RECORDER_TOKEN` in the
> `auto-school-env` secret (else heartbeats 401 forever). The manifest switch itself is
> ATOMIC: apply platform + recorder manifests together, delete the single-pod manifest in
> the same change — never both (two daemons on one RWO PVC).
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
3. **Pod split**: recorder Deployment (+Service) with today's daemon spec + PVC;
   platform Deployment keeps frontend; drop ro `/data` mount + `BACKEND_URL` from platform;
   media route flips to recorder proxy. Node unpinned for platform.
4. **Cleanup**: delete the two-container manifest, `deploy/k8s/auto-school.yaml` splits into
   `auto-school-platform.yaml` + `auto-school-recorder.yaml`; smoke suite aims at the
   recorder Service.
5. **(later, with ingestion API)** `mode='poll'` recorders — command pull + status push for
   Electron clients; nothing above changes.

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
