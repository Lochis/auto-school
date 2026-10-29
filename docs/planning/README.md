# Planning docs — read order & build sequencing

| Doc | Scope |
| --- | --- |
| `authentik-federation.md` | Identity: forward-auth header trust (EDGE_SECRET), claim flow — **Phases 0/1/2 landed**; §5 platform-held school credentials + §8 full federation SUPERSEDED (keychain, `hosted-platform.md` §6) |
| `multi-user-architecture.md` | **HISTORICAL (2026-10-20)** — pod-per-user scale-out, killed by the hosted-platform pivot; kept for reference |
| `postgres-migration.md` + `postgres-architecture.mmd` | DB schema, importer, cutover phases, CNPG deploy |
| `storage-backends.md` | Pluggable per-user blob storage — **re-scoped 2026-10-20**: user-cloud sync for playback (presigned URLs), platform holds no blobs (see `hosted-platform.md` §4) |
| `hosted-platform.md` | **CURRENT COMMERCIAL DIRECTION** — Electron client + hosted web app, ingestion API, tier decision, revised build order |
| `recorder-split.md` | Daemon-less platform + personal recorder: pod split, per-owner recorder registry (heartbeat, inbound/poll modes), frontend degradation map — **5a steps 1-2 landed, step 3 (manifest cutover) HELD** |
| `ingestion-api.md` | 5b-1: recorder media route + ingestion API v1 (Bearer token, owner-in-body); 5b-2 deferrals listed in §3 — **LANDED 2026-10-29** |
| `deploy-runbook-2026-10-21.md` | Non-destructive ordering for the Phase-2 DDL swap + the recorder-split deploy (plan only; unapplied) |
| `future-product-goals.md` | Deferred product vision (onboarding, AI login recipes, BYOK, billing) |
| `personal-not-commercial-phase3-gaps.md` | Post-Phase-3 gaps split: personal-only (calendar, mapping candidates — deferred) vs commercial (materials single source of truth + auto-embed, avatar upload/FaceHash — provider picture claim removed) |

## Recommended build order (dependency-driven) — revised 2026-10-20, see hosted-platform.md

1. **Authentik Phase 0** — ✅ DONE (edge identity, header trust, navbar user).
2. **Postgres migration** — ✅ DONE (all 4 cutover phases; fs metadata tree is backup-only).
3. **Authentik Phase 1** — ✅ DONE (`feat/authentik-phase1`): per-request owner binding
   end-to-end; courses/mappings/documents/settings deliberately system-global.
4. **Multi-tenant schema hardening ("Phase 2")** — ✅ DONE (`feat/authentik-phase2`, 2026-10-21,
   verifier-approved): sessions unique + upsert + resolveSession/updateSession owner-scoped;
   app_settings per-user overlay (system+user shallow merge, writes to request owner).
   Deploy note: run the appended ddl.sql Phase-2 migration block on prod before rollout.
   (Pod-per-user workers were step 4 — DEAD 2026-10-20, daemon is personal-only.)
5. **Platform split** — two independent halves:
   - **5a — recorder split** (`recorder-split.md`): frontend daemon-less, personal recorder =
     own Deployment + registry. **CODE DONE** (`5e40545`); **manifest cutover HELD** — the
     single-pod is still live, see `recorder-split.md` §5.
   - **5b-1 — ✅ DONE** (`feat/ingestion-api`, 2026-10-29): ingestion API v1 + recorder media
     route (`ingestion-api.md` §4). Unblocks the held 5a cutover.
   - **5b-2 — deferred**: deadlines submission, deadline/checklist mutation split,
     platform-side AI generation, full OIDC (`ingestion-api.md` §3).
6. **Electron packaging** — web app shell + capture engine + sync client.
7. **Storage backends** — re-scoped: user-cloud blob sync for playback, presigned URLs,
   platform holds no blobs.

Social SSO (Google/Microsoft/Discord/GitHub) is Authentik-source config only —
no schema change, no sequencing constraint (see `future-product-goals.md` §D).
