# 2026-10-30 — owner-scope wave: `courses.slug`, `meeting_mappings.match_title`, `documents`

Third application of the expand → deploy → contract pattern. Precedents:
`docs/planning/deploy-runbook-2026-10-21.md` §8 (deadlines, applied 2026-10-29) and
the sessions swap in the same runbook. Fixes the cross-owner collision class flagged in
`docs/planning/ingestion-api.md` §3a.1 (documents sibling finding) plus the same latent
bug in `courses.slug` and `meeting_mappings.match_title`.

## What changes

| table | old arbiter (globally unique) | new arbiter (owner-scoped) |
|---|---|---|
| `courses` | `courses_slug_key` (`slug`) | `(slug, owner_user_id)` as `courses_slug_owner_key` |
| `meeting_mappings` | `meeting_mappings_match_title_key` (`match_title`) | `(match_title, owner_user_id)` as `meeting_mappings_match_title_owner_key` |
| `documents` | `documents_course_id_kind_rel_path_key` (`course_id, kind, rel_path`) | `(course_id, kind, rel_path, owner_user_id)` as `documents_course_kind_rel_path_owner_key` |

All three old arbiters are **UNIQUE CONSTRAINTS** on prod (not bare indexes) — confirmed
live 2026-10-30 via `\d` on `deploy/auto-school-pg` (postgres 17.11). Contract therefore
uses `ALTER TABLE … DROP CONSTRAINT`, not `DROP INDEX`.

## documents.owner_user_id: already present — NO backfill needed

Introspected live: `documents.owner_user_id uuid NOT NULL REFERENCES users(id)` **already
exists** (unlike the deadlines wave's expand-then-alter). Every prod row already carries an
owner. For reference, the documented derivation had a backfill been required:

- `kind != 'material'` rows: owner derivable from the session row —
  `documents.session_id → sessions.owner_user_id`.
- `kind = 'material'` rows: owner derivable from the course row —
  `documents.course_id → courses.owner_user_id` (courses are per-owner since this wave;
  pre-wave, all rows are the seed owner anyway).

Residual-check SQL (expect 0):

```sql
select count(*) from documents d
  left join sessions s on s.id = d.session_id
 where d.session_id is not null and d.owner_user_id is distinct from s.owner_user_id;
```

(Prod is single-owner — every row is `00000000-0000-0000-0000-000000000001` — so the
owner-scoped indexes cannot collide on existing data. A `23505` during expand means a
second owner appeared; abort and investigate, don't dedup.)

## Code changes shipped with this wave (must be deployed BETWEEN expand and contract)

- `src/db/writes.ts` — `courseId()`, `upsertCourseConfig()` stamp `curOwner()` and target
  `(slug, owner_user_id)`; `upsertMapping()` targets `(match_title, owner_user_id)` (the
  old same-owner WHERE guard is now redundant and removed).
- `src/db/embed-sessions.ts` — session-artifact documents rows now stamp `s.owner_user_id`
  (derived from the session row, not the sweeping caller) and target the 4-column arbiter.
  The `owner` opt was removed (the platform ingest route kick no longer needs it).
- `src/db/ingest-embed.ts` (`embedOneMaterial`) — 4-column conflict target.
- `src/pipeline/materials.ts` — KNOWN RESIDUAL CLOSED: `hydrateCourseConfigs()` select is
  owner-scoped (`curOwner()`, resolveCourses pattern); `upsertDocumentRow` stamps
  `curOwner()` + 4-column target; `listMaterials` / `forgetDocumentRows` /
  `moveDocumentRows` course-id subselects are owner-scoped (they would become
  scalar-subquery errors once two owners share a slug).
- `src/daemon.ts` — the four remaining unscoped `slug` lookups (session move/purge,
  course rename, course delete) are owner-scoped via `curOwner()`.
- `src/db/gen/{deadlines,tools}.ts`, `src/db/gen/doc-source.ts` — platform generator
  course list / semesterStart / doc-source subselect owner-scoped (wave C gap).
- `src/db/schema.ts` + `src/db/ddl.sql` — final owner-scoped shape (named constraints) +
  idempotent convergence blocks in the multi-tenant hardening section.
- `scripts/import-fs-to-pg.ts`, `scripts/embed-backfill.ts`, `scripts/smoke.ts` — all
  conflict targets on these three tables owner-scoped (clears the §8.5 rot for this wave).

## Order of operations (MANUAL, prod)

1. **EXPAND** — `expand.sql`. No transaction (CONCURRENTLY). Safe under old code.
2. **DEPLOY** — build + push both images, roll out `deploy/auto-school-recorder` and
   `deploy/auto-school-platform` (`kubectl rollout status` each). Must follow expand
   immediately-ish; the live old code is unaffected by expand.
3. **WRITE-PROBE** (deadlines precedent — rolled-back transaction, one statement per
   arbiter; every one must report `INSERT 0 1` with NO "no unique or exclusion
   constraint" / 23505-with-wrong-arbiter error):

```sql
BEGIN;
-- courses
INSERT INTO courses (slug, name, owner_user_id)
VALUES ('__probe__', '__probe__', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (slug, owner_user_id) DO UPDATE SET name = excluded.name;
-- meeting_mappings (course_id any existing course id)
INSERT INTO meeting_mappings (match_title, norm_title, course_id, source, owner_user_id)
SELECT '__probe__', '__probe__', min(id), 'manual', '00000000-0000-0000-0000-000000000001' FROM courses
ON CONFLICT (match_title, owner_user_id) DO UPDATE SET norm_title = excluded.norm_title;
-- documents (material row on an existing course)
INSERT INTO documents (course_id, kind, rel_path, filename, owner_user_id)
SELECT min(id), 'material', '__probe__', '__probe__', '00000000-0000-0000-0000-000000000001' FROM courses
ON CONFLICT (course_id, kind, rel_path, owner_user_id) DO UPDATE SET filename = excluded.filename;
ROLLBACK;
```

   Plus a UI round-trip (edit one course's icon/semester — exercises
   `upsertCourseConfig` owner-scoped) and
   `kubectl logs deploy/auto-school-recorder --since=30m | grep -Ei "on conflict|23505|no unique or exclusion"`
   → empty.

4. **CONTRACT** — `contract.sql` (drops the three old constraints + ANALYZE).
   Do NOT run before 2–3: old-code writes on these tables fail without their arbiter.

## Residual window (deploy → contract)

Same shape as §8: the old global uniques still exist, so a second owner inserting a
slug/match_title/rel_path the seed owner already has gets `23505` instead of a fresh
row — no longer corrupting, not yet multi-owner-complete. Single-owner prod is
unaffected. **Do not onboard a second user before contract.**

## Fresh installs / dev / CI

Nothing to do: `src/db/ddl.sql` now creates the owner-scoped constraints directly
(`courses_slug_owner_key`, `meeting_mappings_match_title_owner_key`,
`documents_course_kind_rel_path_owner_key`). Naming note (§8): a fresh DB gets
pg_constraint rows; the migrated prod DB gets bare unique indexes of the same names —
`on conflict (…)` works against both. Re-running ddl.sql wholesale on a pre-wave DB
converges it (hardening section drops the old constraints) — that path is the CONTRACT
step and must only run with the new code live.
