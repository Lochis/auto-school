# Planning: per-user ingest tokens (hashed, per-owner bearer credentials)

Status: **design** (not landed). Serves hosted-platform.md §3 — external Electron clients
submitting via the ingestion API as *their own* owner, not the seed owner. Supersedes the
"P3 remainder (multi-client future)" bullet in security-hardening.md §P3 for the ingest
surface; recorder-registry tokens stay scoped out (§4).

Today: one shared `INGEST_TOKEN` (secretKeyRef `auto-school-env`) authenticates
`POST /api/ingest/session`, and wave D binds it hard to the seed owner — the route 401s
unless `body.owner` resolves to `SYSTEM_OWNER` (`frontend/src/app/api/ingest/session/route.ts:161`,
`getUserIdBySub` + `!== SYSTEM_OWNER`). A hosted user's client therefore *cannot* ingest.
Per-user tokens fix that: **the owner comes from the token, not the body.**

## 1. Token model

New PG table `ingest_tokens` (name mirrors `recorders`: short, per-owner, registry-ish).

```sql
-- ddl.sql: append after the `recorders` table (fresh-install final shape).
CREATE TABLE IF NOT EXISTS ingest_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  token_hash    text NOT NULL UNIQUE,        -- sha256 hex of the full raw token
  prefix        text NOT NULL,               -- first 12 chars, e.g. 'asi_9f3ab2c1' — display only
  label         text NOT NULL DEFAULT '',    -- user-chosen, e.g. 'laptop electron client'
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,                 -- audit trail (§6); fire-and-forget update
  expires_at    timestamptz,                 -- NULL = never
  revoked_at    timestamptz                  -- NULL = active; set = revoked, checked at lookup
);
CREATE INDEX IF NOT EXISTS ingest_tokens_owner_idx ON ingest_tokens (owner_user_id, created_at DESC);
```

**Raw token format:** `asi_<base64url(32 random bytes)>` — 256-bit entropy, 47 chars
(`crypto.randomBytes(32)`). Shown **once** in the create response (GitHub-PAT model); only
`token_hash` is stored. The DB can never leak a usable credential.

| Decision | Choice | Why |
|---|---|---|
| Hash | sha256 hex of the raw string | Input is 256-bit random — brute-force resistance comes from entropy, not key stretching; bcrypt/argon2 would only slow the (already-indexed) lookup |
| Unique arbiter | `token_hash UNIQUE` (in-table constraint) | New empty table ⇒ **no `CONCURRENTLY` needed** (deploy-runbook-2026-10-21.md §8 reserves that for backfilled arbiters); lookup is the hot path, the PK id is only for the DELETE route |
| `prefix` not unique | Deliberate | Display-only; 12 chars of a 256-bit space never disambiguates a real token |
| Drizzle mirror | `src/db/schema.ts` `ingestTokens` (uuid/text/tstz, `tstz()` helper) | ddl.sql stays authoritative; schema.ts is the typed mirror (file header) |
| Owner FK | `users(id)`, no cascade decision — plain `REFERENCES` | Matches every other `*_owner_user_id` column in ddl.sql |

## 2. Issuance + management UX

Authenticated users manage tokens from their profile page
(`frontend/src/app/profile/page.tsx` — section under the avatar panel). All routes
`requireUser()`-gated (fail-closed, same as `api/me/avatar`); **owner is always the session
user — never a body param.**

```
GET    /api/me/tokens        → [{ id, prefix, label, createdAt, lastUsedAt, expiresAt, revokedAt }]
POST   /api/me/tokens        → { label?, expiresInDays? } ⇒ { id, token }   # token shown ONCE
DELETE /api/me/tokens/:id    → { ok: true }                                  # sets revoked_at
```

Sketch (route file, `frontend/src/app/api/me/tokens/route.ts`):

```ts
export async function POST(req: Request) {
  const owner = await requireUser();
  if (!owner) return unauthorized();                       // 401, never a seed fallback
  const { label = "", expiresInDays } = (await req.json()) as { label?: string; expiresInDays?: number };
  const raw = `asi_${randomBytes(32).toString("base64url")}`;
  const row = await createIngestToken(owner, {             // src/db/ingest-tokens.ts
    tokenHash: createHash("sha256").update(raw).digest("hex"),
    prefix: raw.slice(0, 12), label: String(label).slice(0, 64),
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 864e5) : null,
  });
  return NextResponse.json({ id: row.id, token: raw });    // raw leaves the server exactly once
}
```

DELETE is owner-scoped at the SQL level (`delete … where id = $1 and owner_user_id = $2`
returning — 0 rows → 404), mirroring `src/db/recorders.ts` parameterized style. The
recorder/Electron client is the **seed owner's** client today (it holds `INGEST_TOKEN`);
once re-keyed it uses its own token; hosted users mint theirs post-hosted-tier.

## 3. Auth flow change in /api/ingest/session

New resolver `src/db/ingest-tokens.ts` (drizzle-free, parameterized — same convention as
`src/db/writes.ts`; imports a pool via `src/db/client.ts`):

```ts
/** Bearer → active token row → owner. NULL = no match / revoked / expired (all → 401,
 *  one response shape — no state oracle). */
export async function resolveIngestToken(bearer: string) {
  const hash = createHash("sha256").update(bearer).digest("hex");
  const r = await getPool().query(
    `select id, owner_user_id from ingest_tokens
      where token_hash = $1 and revoked_at is null
        and (expires_at is null or expires_at > now())`, [hash]);
  const row = r.rows[0];
  if (!row) return null;
  void getPool().query(                                    // fire-and-forget audit bump
    `update ingest_tokens set last_used_at = now() where id = $1`, [row.id])
    .catch(() => {});
  return { tokenId: row.id as string, ownerUserId: row.owner_user_id as string };
}
```

Route change (`frontend/src/app/api/ingest/session/route.ts` POST), **lookup order**:

1. `resolveIngestToken(bearer)` hit → `ownerUserId = row.ownerUserId` (from the TOKEN).
   `body.owner`, if still sent by the client, must resolve to the same `users.id` — a
   mismatch is `401` (defensive: catches misconfigured clients instead of silently
   writing under the token's owner while the client thinks otherwise).
2. Miss → legacy shared-secret compare (`tokenOk()`, sha256 + `timingSafeEqual`, unchanged)
   → wave-D seed-owner bind (`body.owner` → `SYSTEM_OWNER`) exactly as landed.
3. Neither → `401 { ok:false, error:"unauthorized" }` (fail closed, unchanged).

Both paths converge on the existing body: `ownerALS.run(ownerUserId)` writes, embed kick
passes `{ owner: ownerUserId }` (5b-2c A2) — so **documents/deadlines owner = token owner**,
which is what makes §3a attribution real for non-seed owners. The §3a.1 `documents` arbiter
migration stays a separate, already-tracked pre-multi-owner blocker — out of scope here.

- **`last_used_at`** is best-effort, never awaited into the response path.
- **Media/upload paths:** ingest v1 accepts no media (video sync = storage-backends §4).
  Any future `/api/ingest/*` upload route imports the same `resolveIngestToken`; the GET
  `/api/media/[...path]` stream stays session-auth (`requireUser`) — different caller, no change.

### Legacy alias + deprecation

| Phase | `INGEST_TOKEN` (shared) | per-user tokens |
|---|---|---|
| expand + deploy | works, seed-owner bind (wave D) | mintable, preferred |
| all clients re-keyed | still works | works |
| deprecate | remove key from `auto-school-env` (optional:true ⇒ pods fine), delete `tokenOk()` fallback | only path |

Removal is a **runbook step, not SQL** — no code checks for the env var's absence.

## 4. Explicitly out of scope (what does NOT change)

| Surface | Status | Justification |
|---|---|---|
| Daemon hop HMAC (`INTERNAL_HMAC_KEY`, `daemonUserHeaders()`) | unchanged | Service-to-service platform↔recorder trust; owner already threads via `X-Auto-School-User` + `resolveRequestOwner`. Tokens are client→platform. |
| `EDGE_MARKER` chain | unchanged | Edge identity, orthogonal to bearer credentials. |
| `RECORDER_TOKEN` / heartbeat registry | **scoped out** | Recorder-registry auth (`api/recorder/heartbeat`), not ingest. Registry rows already key `(owner_user_id, name)` and wave D hardened the merge + SSRF checks; per-user recorder tokens remain a P3-remainder follow-up with zero shared code with this design. Folding it in would double WP2 for nothing. |
| `/api/media` GET proxy | unchanged | Session-auth browser path (§3). |
| OIDC token verification | unchanged (still deferred) | ingestion-api.md §3 "Still DEFERRED" — this design is the interim bearer upgrade, not the final OIDC endgame. |

## 5. Migration plan (expand → deploy → contract)

1. **Expand** — additive `CREATE TABLE IF NOT EXISTS ingest_tokens` (+ indexes) applied via
   psql per deploy-runbook §8 style; recorded into `ddl.sql` (fresh-install shape) and
   `src/db/schema.ts` in the same commit. Single tx; **no `CONCURRENTLY`** — brand-new empty
   table, nothing backfilled, no arbiter swap (contrast §3b.1/§3a.1 which need it).
2. **Deploy** — code (WP1–WP3) any time after expand. No ordering hazard: the table starts
   empty, so every request still resolves via the legacy path until someone mints a token.
3. **Contract** — **none.** Nothing dropped, no constraint replaced. The only retirement is
   the shared-token key removal (§3 table), which is reversible-by-re-adding-the-key.

**Rollback:** revert the image tag → legacy path unaffected (token lookups just stop
happening). `DROP TABLE ingest_tokens` is safe any time while it holds only revocable
credentials; do it first if you also want the minted tokens gone.

## 6. Threat notes

| Concern | Mitigation |
|---|---|
| DB leak of credentials | Only `token_hash` stored; raw shown once (§1). sha256 is sufficient — see decision table. |
| Timing oracle on compare | Hash-then-index-lookup (no compare at all — the standard PAT pattern). The legacy shared-secret path keeps `sha256` + `timingSafeEqual` unchanged. |
| Revocation latency | Lookup hits PG on **every** request — revocation is immediate. **No token→owner cache.** If profiling ever demands one, it must be TTL ≤ 60s (recorded decision, not implemented). |
| Brute force | 256-bit random + unique hash index; no rate limit this phase (deferred — an online guess of a 256-bit space is moot, and the authentik edge already fronts `/api/*`). Revisit for the hosted tier. |
| State oracle | Revoked, expired, and unknown all return the identical `401 {ok:false,error:"unauthorized"}`. |
| Audit | `last_used_at` per token (lightweight); `created_at`/`prefix`/`label` in the profile list. Full `activity_events` integration deliberately not added (platform routes emit no feed events — ingestion-api.md §3b.3 precedent). |
| Over-issuance | Soft cap (e.g. 20 active tokens/owner) in `createIngestToken` — cheap, avoids unbounded rows; exact number an open question. |

## 7. Implementation split

| WP | Contents | Files |
|---|---|---|
| **WP1 — schema + store + routes** | ddl.sql + drizzle mirror; `src/db/ingest-tokens.ts` (`resolveIngestToken`, `createIngestToken`, `listIngestTokens`, `revokeIngestToken`); `/api/me/tokens` GET/POST + `/api/me/tokens/[id]` DELETE (requireUser-gated) | `src/db/ddl.sql`, `src/db/schema.ts`, `src/db/ingest-tokens.ts` (new), `frontend/src/app/api/me/tokens/route.ts` (new), `frontend/src/app/api/me/tokens/[id]/route.ts` (new) |
| **WP2 — ingest binding change** | Resolver-first lookup in POST; `body.owner` cross-check on token path; legacy fallback retained; delete `SYSTEM_OWNER` hard-bind only after deprecation | `frontend/src/app/api/ingest/session/route.ts` (tokenOk region ~:47 + POST auth region ~:147-165) |
| **WP3 — profile UI** | Tokens section: list (prefix/label/last used), create dialog with one-time raw display + copy, revoke confirm | `frontend/src/app/profile/page.tsx`, `frontend/src/profile-ui.css` |

WP1 and WP2 are independently shippable (WP1 alone changes nothing observable; WP2 alone is
a no-op while the table is empty). WP3 depends on WP1 only.

## Open questions

1. `body.owner` for per-user-token callers: **cross-check-and-401** (this doc) vs
   *ignore entirely* (owner always = token)? Cross-check catches client bugs but keeps a
   body field that is now redundant — contract doc (ingestion-api.md §2) must be updated either way.
2. Active-token cap per owner (§6): 20? And a default `expiresInDays` for hosted users
   (seed owner: none)?
3. Rate limiting on `/api/me/tokens` POST + failed-ingest backoff: defer to hosted tier?
4. Deprecation date for the shared `INGEST_TOKEN` — after the seed owner's recorder is
   re-keyed, or bundle with the OIDC-verification work?
5. Per-user recorder tokens (`RECORDER_TOKEN` follow-up): same table with a `kind` column
   (`'ingest' | 'recorder'`) vs a separate `recorder_tokens` table — decide when that lands;
   this design keeps `ingest_tokens` single-purpose for now.
