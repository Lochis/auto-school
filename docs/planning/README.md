# Planning docs — read order & build sequencing

| Doc | Scope |
| --- | --- |
| `authentik-federation.md` | Identity: forward-auth header trust, per-user credentials, claim flow |
| `multi-user-architecture.md` | Concurrency verdict + pod-per-user scale-out design |
| `postgres-migration.md` + `postgres-architecture.mmd` | DB schema, importer, cutover phases, CNPG deploy |
| `storage-backends.md` | Pluggable per-user blob storage (`file://`/`s3://`), publish/playback/retention flows |
| `future-product-goals.md` | Deferred product vision (onboarding, AI login recipes, BYOK, billing) |

## Recommended build order (dependency-driven)

1. **Authentik Phase 0** — trust `X-authentik-*` headers, strip spoofed inbound copies,
   show logged-in user in navbar/Settings (`frontend/src/lib/auth.ts`). No dependencies;
   independent of the DB work. Land on a small branch off `main`.
2. **Postgres migration** (this branch) — schema incl. `users` + `lochis` seed/claim,
   importer, `DATA_BACKEND` cutover phases. No dependency on identity; single-user throughout.
3. **Authentik Phase 1** — per-user data keys: uid → `owner_user_id` filters on the
   DB queries that replaced fs scans. Requires 1 + 2. (Doing per-user partitioning on the
   filesystem *before* the DB cutover would be throwaway work — explicitly rejected.)
4. **Pod-per-user workers** — control plane + per-user daemon pods. Requires all of the
   above plus the frontend/daemon pod split (multi-user doc Phase 1–2).
5. **Storage backends** (`storage-backends.md`) — per-user blob storage + creds. Requires 3
   (Authentik Phase 1); independent of postgres cutover Phases 3–4 (blob I/O ≠ metadata I/O).

Social SSO (Google/Microsoft/Discord/GitHub) is Authentik-source config only —
no schema change, no sequencing constraint (see `future-product-goals.md` §D).
