# Runbook — non-destructive multi-tenant migration + recorder-split deploy (2026-10-21)

Repo: `/mnt/dev/Repos/auto-school`, branch `main` @ `7905b06`.
Target: prod DB `auto-school-pg` in namespace `auto-school`.
Status: **plan only — nothing in this document has been applied.**

## 0. Why this runbook exists (the mismatch window)

`src/db/ddl.sql:288-317` is a **hard swap**: it drops the old uniqueness before the
new one is deployed (`src/db/ddl.sql:296`, `:311`). That is correct for a fresh DB
(`src/db/ddl.sql:72-73`, `:223-229`) and for a same-container `init` run, but it is
*not* safe to apply to prod while **old code** is still serving writes:

| code | sessions arbiter | app_settings arbiter |
|---|---|---|
| old (pre-`9774f5a`) | `on conflict (course_id, stem)` — `src/db/writes.ts:56` @ `9774f5a^` | `on conflict (key)` — `src/db/state.ts:31` @ `9774f5a^` |
| new (`main` @ `7905b06`) | `on conflict (course_id, stem, owner_user_id)` — `src/db/writes.ts:56` | `on conflict (key, owner_user_id)` — `src/db/state.ts:55` |

`on conflict (<cols>)` requires a **live unique/PK index on exactly those columns**, so
dropping `sessions_course_id_stem_key` / `app_settings_pkey` early makes every old-code
write raise *"there is no unique or exclusion constraint matching the ON CONFLICT
specification"* → the running daemon's session/settings writes fail hard.

Fix: **expand first (purely additive), deploy, verify, then contract.** Old code keeps
its arbiters throughout the expand phase; new code gets its arbiters before it starts.

Verified prod state (given, do not re-litigate): `sessions` has
`sessions_course_id_stem_key UNIQUE (course_id, stem)`, `app_settings` has
`app_settings_pkey PRIMARY KEY (key)`, **no** `recorders` table, all rows owned by seed
owner `00000000-0000-0000-0000-000000000001` (`src/db/ddl.sql:24-26`).

### Accepted residual risk during expand→contract window

While both `UNIQUE (course_id, stem)` **and** `UNIQUE (course_id, stem, owner_user_id)`
exist, new code's `INSERT … ON CONFLICT (course_id, stem, owner_user_id)` will still be
*rejected by the old two-column constraint* if a **second** owner inserts a stem that
owner #1 already owns. Same for `app_settings` (old PK on `key` alone). This is fine for
prod today (single owner, all rows seed-owned) but **contract must complete before any
second user is onboarded** — that is the actual deadline, not the deploy.

---

## 1. EXPAND (apply FIRST; safe while old code runs)

All of it is a **single additive transaction** — no `CONCURRENTLY` inside it, no
`DROP`, nothing that can lose data or existing arbiters.

```sql
-- expand.sql
BEGIN;

-- 1a. sessions: composite natural key gains owner_user_id.
--     Idempotent via the same pg_constraint probe ddl.sql:298-305 uses.
--     WARNING: do NOT copy the DROP CONSTRAINT IF EXISTS from ddl.sql:296 here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_course_stem_owner_key'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_course_stem_owner_key
      UNIQUE (course_id, stem, owner_user_id);
  END IF;
END
$$;

-- 1b. app_settings: per-user overlay column, backfilled by DEFAULT.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS owner_user_id uuid NOT NULL
  REFERENCES users(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- 1c. app_settings: composite natural key. Idempotent probe as above.
--     WARNING: do NOT copy the DROP CONSTRAINT IF EXISTS from ddl.sql:311 here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_settings_key_owner_key'
      AND conrelid = 'app_settings'::regclass
  ) THEN
    ALTER TABLE app_settings ADD CONSTRAINT app_settings_key_owner_key
      UNIQUE (key, owner_user_id);
  END IF;
END
$$;

-- 1d. recorders: byte-identical to src/db/ddl.sql:325-333.
--     Required BEFORE new code starts: the heartbeat upserts here
--     (src/db/recorders.ts:26-32, `on conflict (owner_user_id, name)`).
CREATE TABLE IF NOT EXISTS recorders (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL DEFAULT 'personal',
  mode          text NOT NULL DEFAULT 'inbound',
  endpoint      text,
  last_seen     timestamptz,
  capabilities  jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (owner_user_id, name)
);

COMMIT;
```

### Why each step is safe against existing data

- **1a** — prod already enforces `UNIQUE (course_id, stem)`. Any two existing rows
  differ in `(course_id, stem)` already, so they *cannot* collide on the strictly
  superset key `(course_id, stem, owner_user_id)`. The new index is therefore
  guaranteed to build without a duplicate-key error on current data. Additive: the old
  constraint stays, so old code's `on conflict (course_id, stem)` still resolves
  (`src/db/writes.ts:56` @ `9774f5a^`).
  Lock note: `ADD CONSTRAINT … UNIQUE` takes `ACCESS EXCLUSIVE` for the index build.
  At this data size that is sub-second. If you want zero blocking, use the
  out-of-transaction variant in §1.1.
- **1b** — `ADD COLUMN … NOT NULL DEFAULT <const>` on PG ≥ 11 is a catalog-only change
  (no table rewrite); every existing row reads as the seed owner. The `DEFAULT` also
  keeps any *old-code* insert (which omits the column) working — that is exactly how
  `ddl.sql:308-310` intends the backfill ("DEFAULT covers existing rows — no explicit
  backfill needed").
- **1c** — prod `app_settings` has `PRIMARY KEY (key)`, i.e. at most one row per key.
  A single row per key trivially satisfies `UNIQUE (key, owner_user_id)`, so the index
  builds clean. Additive: `app_settings_pkey` remains, so old code's
  `on conflict (key)` still resolves (`src/db/state.ts:31` @ `9774f5a^`).
- **1d** — `CREATE TABLE IF NOT EXISTS` for a table that does not exist in prod
  (verified). No existing object is touched; the FK target `users` exists.

### 1.1 Optional zero-downtime variant for 1a/1c (two transactions)

`CREATE UNIQUE INDEX CONCURRENTLY` cannot run inside `BEGIN`, so expand becomes:

```sql
-- step 1: build indexes without blocking writers
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sessions_course_stem_owner_key_idx
  ON sessions (course_id, stem, owner_user_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS app_settings_key_owner_key_idx
  ON app_settings (key, owner_user_id);

-- step 2: adopt them under the canonical names from ddl.sql:300-301 / :315-316
ALTER TABLE sessions     ADD CONSTRAINT sessions_course_stem_owner_key
  UNIQUE USING INDEX sessions_course_stem_owner_key_idx;
ALTER TABLE app_settings ADD CONSTRAINT app_settings_key_owner_key
  UNIQUE USING INDEX app_settings_key_owner_key_idx;
```

Caveat: if a `CONCURRENTLY` build fails it leaves an **INVALID** index that
`IF NOT EXISTS` will then hide — drop it (`DROP INDEX CONCURRENTLY <name>;`) and retry.
For prod-as-it-is, prefer the simple §1 form.

---

## 2. CONTRACT (apply ONLY after new code is deployed and health-verified)

```sql
-- contract.sql
BEGIN;
ALTER TABLE sessions     DROP CONSTRAINT IF EXISTS sessions_course_id_stem_key;
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey;
COMMIT;
```

`COMMIT` immediately, then `ANALYZE sessions; ANALYZE app_settings;` (outside the txn)
so the planner picks up the new indexes.

### Why it must wait

- Dropping `sessions_course_id_stem_key` (`src/db/ddl.sql:296` equivalent) removes old
  code's only `(course_id, stem)` arbiter → its `INSERT … ON CONFLICT` starts erroring.
- Dropping `app_settings_pkey` (`src/db/ddl.sql:311` equivalent) removes old code's
  `(key)` arbiter → settings writes + settings *load* path degrade.
- Conversely, dropping them **after** new code is live is what makes the expand window
  close: with only the composite uniques left, the second-owner-insert rejection
  described in §0 disappears, and `sessions`/`app_settings` become genuinely
  multi-tenant.
- `app_settings` ends with **no PRIMARY KEY** (only the composite unique). That is
  intentional (`src/db/ddl.sql:223-229`), and safe here: nothing FK-references
  `app_settings`, and logical replication is not in play (no `REPLICA IDENTITY`
  dependency). Do not "fix" this by adding a surrogate PK without a schema change to
  `ddl.sql` first.
- Last `ON CONFLICT` check before contracting: `sessions` must keep the composite
  unique that `src/db/writes.ts:56` names, `app_settings` the one
  `src/db/state.ts:55` names, `recorders` its PK used by `src/db/recorders.ts:29`.

---

## 3. ROLLBACK per phase

### 3.1 Expand rollback (before new code runs — always safe)

Loses nothing while all rows are still seed-owned; **check first** (see 3.1.0).

```sql
-- 3.1.0 precondition: no per-owner rows yet (must both return 0)
SELECT count(*) AS non_seed_settings FROM app_settings
 WHERE owner_user_id <> '00000000-0000-0000-0000-000000000001';
SELECT count(*) AS non_seed_sessions FROM sessions
 WHERE owner_user_id <> '00000000-0000-0000-0000-000000000001';
```

```sql
-- 3.1.1 rollback (safe: no DROP of anything that old code depends on)
BEGIN;
ALTER TABLE sessions     DROP CONSTRAINT IF EXISTS sessions_course_stem_owner_key;
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_key_owner_key;
ALTER TABLE app_settings DROP COLUMN IF EXISTS owner_user_id;   -- cascade: drops app_settings_key_owner_key too if still present
DROP TABLE IF EXISTS recorders;
COMMIT;
```

If non-seed counts are > 0 you are *post*-deploy: export those rows before the
`DROP COLUMN` (it is destructive for them), or skip 3.1.1 and instead roll forward.

### 3.2 Deploy rollback (new code bad, new code has already written)

The schema is backward compatible with old code as long as **both** old constraints
still exist (i.e. contract not yet applied). So: roll the image tag back and you are
done — no SQL. If contract already ran, you must roll SQL back first (§3.3), *in this
order*: old constraints restored → old image rolled out.

### 3.3 Contract rollback (restore the old arbiters)

```sql
-- 3.3.0 precondition: prove the old keys are still unique in the data.
-- Any row here means the old constraint CANNOT be re-added yet.
SELECT course_id, stem, count(*) AS n, count(DISTINCT owner_user_id) AS owners
  FROM sessions GROUP BY course_id, stem HAVING count(*) > 1;
SELECT key, count(*) AS n, count(DISTINCT owner_user_id) AS owners
  FROM app_settings GROUP BY key HAVING count(*) > 1;
```

If both return zero rows:

```sql
-- 3.3.1 restore, then roll the old image back
BEGIN;
ALTER TABLE sessions ADD CONSTRAINT sessions_course_id_stem_key
  UNIQUE (course_id, stem);
ALTER TABLE app_settings ADD CONSTRAINT app_settings_pkey
  PRIMARY KEY (key);
COMMIT;
```

If they return rows, re-adding is impossible by definition — the multi-tenant data now
exists. Then either (a) roll forward (fix new code in place; old code can no longer
serve this data), or (b) fold non-seed rows into the seed owner first, e.g.
`DELETE FROM app_settings WHERE owner_user_id <> '0000…0001';` after exporting, and for
sessions pick a winner per `(course_id, stem)` and re-point/delete the rest. Option (b)
is destructive: snapshot the DB (or `pg_dump -t sessions -t app_settings`) first.

### 3.4 `recorders` rollback after new code has run

`DROP TABLE recorders` is only cosmetic — rows are heartbeat-only (`src/db/recorders.ts`
upserts `last_seen`/`capabilities`), nothing durable. Safe to drop with the code rollback
(§3.1.1 last line).

---

## 4. VERIFY SQL (run after each phase)

### 4.1 After EXPAND — expect 4 rows, old and new side by side

```sql
-- constraints: contype 'u' = unique, 'p' = primary key
SELECT c.conname,
       c.contype,
       pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
 WHERE c.conrelid IN ('sessions'::regclass, 'app_settings'::regclass)
   AND c.contype IN ('u','p')
 ORDER BY c.conrelid::regclass::text, c.conname;
```

Pass criteria (all must hold):

| expectation | why |
|---|---|
| `sessions_course_id_stem_key` still present, `UNIQUE (course_id, stem)` | old code's arbiter (`src/db/writes.ts:56` @ `9774f5a^`) |
| `sessions_course_stem_owner_key` present, `UNIQUE (course_id, stem, owner_user_id)` | new code's arbiter (`src/db/writes.ts:56`) |
| `app_settings_pkey` still present, `PRIMARY KEY (key)` | old code's arbiter (`src/db/state.ts:31` @ `9774f5a^`) |
| `app_settings_key_owner_key` present, `UNIQUE (key, owner_user_id)` | new code's arbiter (`src/db/state.ts:55`) |

```sql
-- recorders table + its PK/FK
SELECT to_regclass('public.recorders') IS NOT NULL AS recorders_exists;
SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c WHERE c.conrelid = 'recorders'::regclass ORDER BY c.contype;
```

Pass: `recorders_exists = t`; one `p` = `PRIMARY KEY (owner_user_id, name)`; one `f` to
`users(id)` (matches `src/db/ddl.sql:325-333`).

```sql
-- app_settings.owner_user_id present, NOT NULL, defaulted to seed owner, fully backfilled
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='app_settings' AND column_name='owner_user_id';
SELECT count(*) AS total,
       count(*) FILTER (WHERE owner_user_id = '00000000-0000-0000-0000-000000000001') AS seed_owned
  FROM app_settings;                       -- total must equal seed_owned
```

```sql
-- row counts must be unchanged by expand (record them at checkpoint 0 and diff)
SELECT 'sessions' t, count(*) FROM sessions
UNION ALL SELECT 'app_settings', count(*) FROM app_settings
UNION ALL SELECT 'recorders', count(*) FROM recorders
UNION ALL SELECT 'users', count(*) FROM users;
```

### 4.2 After CONTRACT — expect old constraints gone, new ones present

```sql
SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
 WHERE c.conrelid IN ('sessions'::regclass, 'app_settings'::regclass)
   AND c.contype IN ('u','p')
 ORDER BY c.conrelid::regclass::text, c.conname;
```

Pass: **no** `sessions_course_id_stem_key`, **no** `app_settings_pkey`; both
`*_key_owner_key` uniques present; `sessions` still has its `id` PK;
`app_settings` has zero `p` rows (documented in §2). Re-run the §4.1 row counts:
identical to post-expand.

```sql
-- index sanity: the uniques must be valid + ready (catches failed CONCURRENTLY builds)
SELECT c.conname, i.indisvalid, i.indisready
  FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
 WHERE c.conrelid IN ('sessions'::regclass, 'app_settings'::regclass, 'recorders'::regclass)
   AND c.contype IN ('u','p');
```

### 4.3 After DEPLOY — functional write probe (proves the arbiters resolve)

Run in the `psql` session *after* rollout, then `ROLLBACK` so nothing is persisted:

```sql
BEGIN;
-- sessions upsert uses the new composite arbiter (src/db/writes.ts:52-56)
INSERT INTO sessions (course_id, stem, session_date, owner_user_id)
SELECT id, '__runbook_probe__', current_date, '00000000-0000-0000-0000-000000000001'
  FROM courses LIMIT 1
ON CONFLICT (course_id, stem, owner_user_id) DO UPDATE SET updated_at = now();
-- app_settings upsert (src/db/state.ts:53-56)
INSERT INTO app_settings (key, value, owner_user_id)
VALUES ('__runbook_probe__', '{}'::jsonb, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (key, owner_user_id) DO UPDATE SET value = excluded.value, updated_at = now();
-- recorder heartbeat (src/db/recorders.ts:27-32)
INSERT INTO recorders (owner_user_id, name, mode, endpoint, last_seen, capabilities)
VALUES ('00000000-0000-0000-0000-000000000001', '__runbook_probe__', 'inbound', NULL, now(), '{}'::jsonb)
ON CONFLICT (owner_user_id, name) DO UPDATE SET last_seen = now();
ROLLBACK;
```

Pass: all three statements succeed (no *"no unique or exclusion constraint matching
the ON CONFLICT specification"*). Also grep the daemon log for
`on conflict`/`23505` errors during the probe window.

---

## 5. Ordered checklist

Callers: **[L]** = local desktop (`/mnt/dev/Repos/auto-school`), **[A]** = agent can run
it, **[H]** = human decision/approval required.

**Transport (applies to every DB step below).** `kubectl` does not exist on the desktop;
it lives on `k3s-admin`, reachable as:

```bash
ssh -o BatchMode=yes root@100.64.0.3 "ssh -o BatchMode=yes lochis@192.168.10.137 'kubectl -n auto-school get pods'"
```

Run SQL **inside the pod** with stdin (never nested `sh -c` quoting):

```bash
# one-off inline
ssh -o BatchMode=yes root@100.64.0.3 "ssh -o BatchMode=yes lochis@192.168.10.137 \
  'kubectl -n auto-school exec -i deploy/auto-school-pg -- psql -U autoschool -d autoschool -v ON_ERROR_STOP=1 -X'" <<'SQL'
SELECT 1;
SQL

# file-based (preferred for this runbook): base64 avoids every quoting layer.
# The .sql files are NOT in the repo — extract the §1/§2 blocks of this runbook into
# /tmp/auto-school-2026-10-21/{expand,contract}.sql (repo stays read-only).
B64=$(base64 -w0 /tmp/auto-school-2026-10-21/expand.sql)
ssh -o BatchMode=yes root@100.64.0.3 "ssh -o BatchMode=yes lochis@192.168.10.137 \
  \"echo $B64 | base64 -d | kubectl -n auto-school exec -i deploy/auto-school-pg -- psql -U autoschool -d autoschool -v ON_ERROR_STOP=1 -X\""
```

`auto-school-pg` is the official postgres image, whose local socket trusts
`POSTGRES_USER` — no password needed (unlike the Bitnami authentik DB). `-v
ON_ERROR_STOP=1` makes a failed statement abort the script (so a `BEGIN` block rolls
back instead of half-applying); `-X` ignores any `psqlrc`.

| # | step | who | exact command | pass criterion |
|---|---|---|---|---|
| 0 | **Checkpoint** — capture pre-state, save as `/tmp/auto-school-2026-10-21/pre.txt` | [A] | run §4.1 constraint query + §4.1 row counts + `kubectl -n auto-school get deploy auto-school auto-school-pg -o wide` + `get deploy -o jsonpath` image tags | file exists; output shows `sessions_course_id_stem_key`, `app_settings_pkey`, **no** `recorders`; image tag recorded |
| 1 | **Pre-flight asserts** — nobody else is deploying; no non-seed owners | [H]+[A] | `SELECT count(*) FROM sessions WHERE owner_user_id <> '0000…0001';` (same for app_settings) | both `0`; a human confirms no rollout in progress |
| 2 | **Apply EXPAND** (§1) | [A] | `mkdir -p /tmp/auto-school-2026-10-21`; copy §1 code block verbatim into `/tmp/auto-school-2026-10-21/expand.sql`; base64 stdin pipe it | psql exits 0; ends with `COMMIT` |
| 3 | **Verify expand** (§4.1) | [A] | §4.1 queries, append to /tmp/auto-school-2026-10-21/expand.out | all four constraints coexist; `recorders_exists = t`; `total = seed_owned`; row counts == step 0 |
| 4 | **Build + push images** (new code) | [A]/[H] | repo's normal build/push; record resulting tag | images pushed, tag recorded in /tmp/auto-school-2026-10-21/tags.txt; **no** prod change yet |
| 5 | **Deploy images** (daemon + frontend; mindful of `7905b06` atomic-cutover notes) | [H] | `kubectl -n auto-school set image deploy/auto-school <c>=<tag>` (and the pg-side deploy if the manifest pins it) / `kubectl apply -f` | rollout completes, `kubectl rollout status` OK |
| 6 | **Verify health** — pods Ready, writes OK, no conflict errors | [A] | `kubectl -n auto-school get pods`; `kubectl logs deploy/auto-school --since=10m \| grep -Ei 'on conflict\|23505\|error'`; §4.3 probe | all pods `Running/Ready`; probe's 3 statements succeed; no `23505` / no "no unique or exclusion constraint matching" in logs; UI loads and a settings save + a session write round-trip |
| 7 | **Apply CONTRACT** (§2) — **only** if step 6 fully passed | [H]+[A] | copy §2 code block verbatim into `/tmp/auto-school-2026-10-21/contract.sql`; base64 stdin pipe it, then `ANALYZE sessions; ANALYZE app_settings;` | psql exits 0; 2 `DROP CONSTRAINT` notices/`ALTER TABLE` |
| 8 | **Verify contract** (§4.2 + row counts) | [A] | §4.2 | old constraints absent, new present + `indisvalid`/`indisready`; `app_settings` has no PK; row counts unchanged |
| 9 | **Post-contract write probe** | [A] | re-run §4.3 (now genuinely exercising only the new arbiters) + observe daemon for ~10 min | 3 statements succeed, `ROLLBACK`; no `23505` in logs over the observation window |
| 10 | **Final checkpoint** — snapshot post-state | [A] | §4.1/§4.2 queries + row counts + image tags → `/tmp/auto-school-2026-10-21/post.txt` | file exists; delta vs step 0 is exactly: `+sessions_course_stem_owner_key`, `+app_settings_key_owner_key`, `+recorders`, `+app_settings.owner_user_id`, `−sessions_course_id_stem_key`, `−app_settings_pkey`; row counts equal |

Abort/rollback decision points: **step 2/3 fail → §3.1.1** (trivially reversible, old
code never stopped). **step 5/6 fail → §3.2** (image rollback only; do NOT run contract).
**step 7/8 fail → §3.3.0**, then fix forward. **step 9 fail → §3.3.0/§3.3.1**, i.e. only
roll contract back if the old keys are provably still unique.

## 6. Follow-ups (do not silently skip)

- `src/db/ddl.sql:296` / `:311` remain the *hard swap* for fresh/CI databases. This
  runbook is a prod-only staging of them; once prod is contracted, the file needs no
  change — but anyone re-running `ddl.sql` against prod will re-drop and re-add, which is
  a no-op for the new constraints and would **re-introduce** the old ones only if they
  exist. Do not hand-run `ddl.sql` against prod outside this runbook.
- Update `docs/planning/postgres-migration.md` with the applied phases + timestamps.
- Second-user onboarding is gated on contract completion (§0 residual risk).

## 7. APPLIED LOG (2026-10-21)

- **EXPAND** applied + verified 2026-10-21 (4 constraints coexisted, `recorders` live, 5 app_settings rows backfilled to seed). Tag `deploy-expand-applied-2026-10-21`.
- **DEPLOY** images built+pushed (ghcr auth refreshed), rollout restart, pod 2/2. Verified: `/api/me` authenticated, `recorder.attached=true` (BACKEND_URL fallback), avatar serves user's real upload (16KB PNG, no provider sync), all 3 `ON CONFLICT` arbiters resolve via transactional probe.
- **CONTRACT** applied + verified 2026-10-21 (old `sessions_course_id_stem_key` + `app_settings_pkey` dropped; new composite uniques sole arbiters; post-contract probe `post-contract-ok`). Daemon login self-healed after restart (cold-start transient, not a regression).
