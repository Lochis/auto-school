-- EXPAND 2026-10-30 — owner-scope wave: courses.slug / meeting_mappings.match_title /
-- documents (course_id, kind, rel_path) gain owner_user_id in their unique arbiters.
-- Pattern + rationale: docs/planning/deploy-runbook-2026-10-21.md §8 (deadlines precedent).
--
-- ORDER: expand (this file) → deploy new code → write-probe → contract.sql.
-- Applying this file is SAFE while old code runs: purely additive, old arbiters untouched.
--
-- ⚠ NO BEGIN/COMMIT — CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
--    Run statement-by-statement via:
--      kubectl -n auto-school exec -i deploy/auto-school-pg -- \
--        psql -U autoschool -d autoschool -v ON_ERROR_STOP=1 -X
--    (paste each statement; each CREATE INDEX returns when the build finishes)
--
-- Idempotent-ish: IF NOT EXISTS hides a PREVIOUS successful build, but a FAILED
-- concurrent build leaves an INVALID index that IF NOT EXISTS then also hides.
-- Statement 4 proves validity — if any row shows indisvalid = f:
--   DROP INDEX CONCURRENTLY <name>;  then re-run that CREATE INDEX. Do NOT run
--   contract.sql while any arbiter below is invalid.
--
-- Live constraint names introspected on prod 2026-10-30 (postgres 17.11,
-- pod auto-school-pg-…; \d courses / \d meeting_mappings / \d documents):
--   courses_slug_key                      UNIQUE CONSTRAINT (slug)
--   meeting_mappings_match_title_key      UNIQUE CONSTRAINT (match_title)
--   documents_course_id_kind_rel_path_key UNIQUE CONSTRAINT (course_id, kind, rel_path)
-- (All three are pg_constraint rows backed by indexes — contract drops CONSTRAINT,
-- not INDEX. documents.owner_user_id ALREADY EXISTS, NOT NULL, FK → users(id):
-- no ADD COLUMN, no backfill needed — see README.md.)

-- 1) courses: per-owner slug arbiter
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS courses_slug_owner_key
  ON courses (slug, owner_user_id);

-- 2) meeting_mappings: per-owner match_title arbiter
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS meeting_mappings_match_title_owner_key
  ON meeting_mappings (match_title, owner_user_id);

-- 3) documents: per-owner natural-key arbiter
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS documents_course_kind_rel_path_owner_key
  ON documents (course_id, kind, rel_path, owner_user_id);

-- 4) prove all three are VALID before anything else runs
SELECT indexrelid::regclass AS index, indisvalid
  FROM pg_index
 WHERE indexrelid IN (
    'courses_slug_owner_key'::regclass,
    'meeting_mappings_match_title_owner_key'::regclass,
    'documents_course_kind_rel_path_owner_key'::regclass
 );
-- expected: 3 rows, indisvalid = t each

-- Rollback (before contract, if the wave is aborted):
--   DROP INDEX CONCURRENTLY courses_slug_owner_key;
--   DROP INDEX CONCURRENTLY meeting_mappings_match_title_owner_key;
--   DROP INDEX CONCURRENTLY documents_course_kind_rel_path_owner_key;
--   (nothing else changed; old code + old arbiters untouched)
