# Running the backend in Kubernetes

One long-lived pod: Xvfb + PulseAudio (null sink) + Playwright Chromium + the
`daemon` command, which polls the Teams calendar, joins live meetings, records,
and runs the notes pipeline. All writable state lives on one PVC at `/data`
(browser profile, graph tokens, notes/, segments/, out/).

## Build

```bash
docker build -t auto-school:local -f deploy/Dockerfile ..
```

Import into k3s (no registry) or push to yours and edit `image:` in
`deploy/k8s/auto-school.yaml`:

```bash
docker save auto-school:local | sudo k3s ctr images import -
```

## First run — one-time interactive bits (do these BEFORE deploying)

The profile needs MFA done once, and Graph needs one device-code approval.
Easiest path: run the container once locally (or `kubectl exec`) with a shell:

```bash
docker run -it --rm -v auto-school-data:/data --env-file .env \
  auto-school:local node src/index.ts login        # approve MFA via Discord ping
docker run -it --rm -v auto-school-data:/data --env-file .env \
  auto-school:local node src/index.ts meetings     # if you want Graph-calendar mode
```

Then the profile in `/data/user-data` is warm — no more MFA.

## Deploy

```bash
kubectl create namespace auto-school
kubectl -n auto-school create secret generic auto-school-env --from-env-file=.env

# backend
 docker build -t auto-school:local -f deploy/Dockerfile .
# frontend
docker build -t auto-school-frontend:local -f frontend/Dockerfile frontend/
# import into k3s (or push to your registry + edit image: in the manifest)
docker save auto-school:local auto-school-frontend:local | sudo k3s ctr images import -

kubectl apply -f deploy/k8s/auto-school.yaml
kubectl -n auto-school logs -f deploy/auto-school -c auto-school
```

The pod runs **two containers**: `auto-school` (daemon, owns /data RW) and
`frontend` (Next.js on :3000, /data RO) exposed via the `auto-school` Service
on port 80 — point Traefik/Ingress at it. They share the pod because a
Longhorn RWO volume can only mount on one node; to split them into separate
Deployments later, recreate the PVC as RWX first.

Frontend local dev against a live data dir:

```bash
cd frontend && npm install
AUTO_SCHOOL_DATA=/path/to/data npm run dev
```

**Redeploying the frontend without touching a recording in progress:**

```bash
docker compose build frontend && docker compose up -d --no-deps frontend
```

(The plain `up -d --build frontend` form has recreated the backend too on
some compose versions — `--no-deps` guarantees it can't. The backend also
handles SIGTERM gracefully now: redeploys stop the recorder and consolidate
instead of orphaning the session.)

## Container-relevant env

| Var | Value in pod | Notes |
|---|---|---|
| `AUTO_SCHOOL_DATA` | `/data` | all writable data under the PVC |
| `USER_DATA_DIR` | `/data/user-data` | Chromium profile (MFA state) |
| `CHROMIUM_SANDBOX` | `0` | no unprivileged userns in default seccomp |
| `TZ` | `America/Toronto` | dated filenames use local dates |
| `POLL_MINUTES` | `2` | daemon calendar poll cadence |
| `CONTROLLER_PORT` | `7800` | daemon HTTP control: `/healthz`, `/status`, `POST /scan?reset=1`, `POST /leave`, `GET/PUT /settings`, `POST /auth/graph` (same-pod localhost; the frontend proxies it at `/api/backend`) |
| `DISCOVERY_SECONDS` | `60` | Graph polling cadence — cheap HTTP, no browser |
| `JOIN_EARLY_MINUTES` | `3` | join this long before a meeting starts |
| `REC_FPS` | `15` | capture fps — 15 ≪ 30 halves encode CPU; slides don't need 30 |

**CPU note:** with a Graph token approved (`POST /auth/graph` once, code pinged
to Discord), discovery is a per-minute HTTP call and the browser only launches
when a meeting is actually joinable. Without it, the daemon falls back to a
full browser calendar-scan every `POLL_MINUTES` (2 min) — that's a heavy
Edge+Teams cold start every cycle.

Everything else comes from the `.env`-backed Secret (Teams creds, webhook,
Gemini/GLM keys, `BATCH_SEGMENTS`).

## Ops notes

- **Recreate strategy** — the profile can only be touched by one Chromium, so
  rolling updates are disabled. Expect ~1 min downtime on redeploys. Fine.
- **Liveness** = `pgrep node src`; if the daemon throws, the pod restarts and
  the warm profile means it logs straight back in.
- **Verify audio capture once**: join a test meeting (`kubectl exec` + run
  `meetings --join --record`), then check `out/calendar.txt`/segments — if the
  webm has a silent track, the null-sink wiring needs attention
  (`pactl info` inside the pod).
- Longhorn snapshot `/data` after first successful MFA — that's your restore
  point if the pod/PVC is ever rebuilt.
