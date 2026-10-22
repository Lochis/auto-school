# Planning docs — read order & build sequencing

| Doc | Scope |
| --- | --- |
| `authentik-federation.md` | Identity: forward-auth header trust, per-user credentials, claim flow |
| `multi-user-architecture.md` | **HISTORICAL (2026-10-20)** — pod-per-user scale-out, killed by the hosted-platform pivot; kept for reference |
| `postgres-migration.md` + `postgres-architecture.mmd` | DB schema, importer, cutover phases, CNPG deploy |
| `storage-backends.md` | Pluggable per-user blob storage — **re-scoped 2026-10-20**: user-cloud sync for playback (presigned URLs), platform holds no blobs (see `hosted-platform.md` §4) |
| `hosted-platform.md` | **CURRENT COMMERCIAL DIRECTION** — Electron client + hosted web app, ingestion API, tier decision, revised build order |
| `recorder-split.md` | Daemon-less platform + personal recorder: pod split, per-owner recorder registry (heartbeat, inbound/poll modes), frontend degradation map |
| `future-product-goals.md` | Deferred product vision (onboarding, AI login recipes, BYOK, billing) |
| `personal-not-commercial-phase3-gaps.md` | Post-Phase-3 gaps split: personal-only (calendar, mapping candidates — deferred) vs commercial (materials single source of truth + auto-embed, avatar stored in `users` not the provider API) |

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
5. **Platform split** — (a) recorder split (`recorder-split.md`): frontend daemon-less, personal recorder = own Deployment + registry; (b) ingestion API + token auth for Electron clients. 
6. **Electron packaging** — web app shell + capture engine + sync client.
7. **Storage backends** — re-scoped: user-cloud blob sync for playback, presigned URLs,
   platform holds no blobs.

Social SSO (Google/Microsoft/Discord/GitHub) is Authentik-source config only —
no schema change, no sequencing constraint (see `future-product-goals.md` §D).
