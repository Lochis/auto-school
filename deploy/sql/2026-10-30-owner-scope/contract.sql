-- CONTRACT 2026-10-30 — owner-scope wave. Run ONLY after:
--   1. expand.sql applied (all three owner-scoped indexes indisvalid = t), AND
--   2. the new code (owner-scoped ON CONFLICT targets) is deployed + rolled out, AND
--   3. the write-probe in README.md passed, AND
--   4. `kubectl logs deploy/auto-school-recorder --since=30m |
--        grep -Ei "on conflict|23505|no unique or exclusion"` returns nothing.
-- Dropping these earlier makes every OLD-code write on these tables fail with
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- Names are PROD-CONFIRMED 2026-10-30 (see expand.sql header). If any DROP errors
-- with "does not exist", re-introspect first — do not guess:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid IN ('courses'::regclass,'meeting_mappings'::regclass,'documents'::regclass)
--      AND contype = 'u';

-- Precondition: exactly the three owner-scoped unique indexes, all valid
SELECT indexrelid::regclass AS index, indisvalid
  FROM pg_index
 WHERE indexrelid IN (
    'courses_slug_owner_key'::regclass,
    'meeting_mappings_match_title_owner_key'::regclass,
    'documents_course_kind_rel_path_owner_key'::regclass
 );
-- expected: 3 rows, indisvalid = t — else STOP

-- The drops (old arbiters; owner-scoped replacements already live)
ALTER TABLE courses DROP CONSTRAINT courses_slug_key;
ALTER TABLE meeting_mappings DROP CONSTRAINT meeting_mappings_match_title_key;
ALTER TABLE documents DROP CONSTRAINT documents_course_id_kind_rel_path_key;

ANALYZE courses;
ANALYZE meeting_mappings;
ANALYZE documents;

-- Post-verify: zero non-owner-scoped uniques remain; new arbiters still valid.
-- NOTE: on this migrated DB the new arbiters are bare unique INDEXES (expand.sql),
-- not pg_constraint rows — a contype='u' query showing 0 rows is EXPECTED.
SELECT indexrelid::regclass AS index, indisvalid, indisunique
  FROM pg_index
 WHERE indrelid IN ('courses'::regclass,'meeting_mappings'::regclass,'documents'::regclass)
   AND indisunique
 ORDER BY indexrelid::regclass::text;
-- expected: the three owner-scoped arbiters above plus each table's _pkey
--            (PKs are unique indexes too) — all indisvalid = t, nothing else.

-- Rollback (only if something broke AFTER contract — requires the new code live,
-- which no longer references the old arbiters, so normally you never re-add):
--   ALTER TABLE courses ADD CONSTRAINT courses_slug_key UNIQUE (slug);           -- re-globalizes slug
--   ALTER TABLE meeting_mappings ADD CONSTRAINT meeting_mappings_match_title_key UNIQUE (match_title);
--   ALTER TABLE documents ADD CONSTRAINT documents_course_id_kind_rel_path_key UNIQUE (course_id, kind, rel_path);
-- These re-adds FAIL (23505) if cross-owner duplicates were created in the window —
-- which is the point: after contract, the old global arbiters are semantically gone.
