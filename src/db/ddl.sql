-- Authoritative DDL for the Postgres migration (plan/postgres-migration.md §2, §2.1, §2.2).
-- Applied via psql; src/db/schema.ts mirrors this for typed queries (Drizzle).
-- Hand-written on purpose: natural keys, partial index, HNSW and text_pattern_ops
-- are clearer in SQL than in generated migrations.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- keyword fallback / fuzzy title match

-- ── users (stub; full design in authentik-federation.md) ──────────────────
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authentik_sub text UNIQUE,                 -- X-authentik-uid = authentik user pk (the stable key, per authentik-federation.md §5); NULL until first login claims the seed row
  username      text UNIQUE,
  email         text UNIQUE,
  display_name  text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'owner'
                CHECK (role IN ('owner','member','viewer')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- ALL pre-migration data belongs to the 'lochis' account (the single existing user).
-- Seed it up-front with a fixed UUID + reserved username; authentik_sub stays NULL
-- until first login claims it (see authentik-federation.md §"claiming existing data").
INSERT INTO users (id, display_name, username, role, authentik_sub)
VALUES ('00000000-0000-0000-0000-000000000001', 'lochis', 'lochis', 'owner', NULL)
ON CONFLICT (id) DO NOTHING;  -- bootstrap owner for every imported row

-- ── courses (replaces folder-union + course.json) ─────────────────────────
CREATE TABLE IF NOT EXISTS courses (
  id             bigserial PRIMARY KEY,
  slug           text NOT NULL,                 -- "Java_Programming" (courses.ts slug()); unique PER OWNER (2026-10-30 wave)
  name           text NOT NULL,                 -- human name
  code           text NOT NULL DEFAULT 'GEN',   -- "26M" | "MAP" | "GEN" (courses.ts:46-56)
  icon           text,                          -- course.json icon
  semester_start date,                          -- course.json semesterStart
  owner_user_id  uuid NOT NULL REFERENCES users(id) DEFAULT '00000000-0000-0000-0000-000000000001',  -- lochis
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT courses_slug_owner_key UNIQUE (slug, owner_user_id)
);

-- ── meeting mappings (replaces mapping.json) ──────────────────────────────
CREATE TABLE IF NOT EXISTS meeting_mappings (
  id               bigserial PRIMARY KEY,
  match_title      text NOT NULL,               -- exact meeting title as captured; unique PER OWNER (2026-10-30 wave)
  norm_title       text NOT NULL,               -- precomputed normalized form (courses.ts:20-21)
  course_id        bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto')),
  owner_user_id    uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_mappings_match_title_owner_key UNIQUE (match_title, owner_user_id)
);
CREATE INDEX IF NOT EXISTS meeting_mappings_norm_idx ON meeting_mappings (norm_title text_pattern_ops);
-- containment matching ("chip truncation", courses.ts:25-32) stays app-side; norm_title
-- narrows candidates. Later: trigram/GIN if the table grows.

-- ── sessions (replaces out/sessions.json + note/recording stems as identity) ──
CREATE TABLE IF NOT EXISTS sessions (
  id            bigserial PRIMARY KEY,
  course_id     bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  stem          text NOT NULL,                  -- "2026-08-20__Java_Programming__T190012"
  session_date  date   NOT NULL,
  start_time    time,                           -- from __THHMMSS suffix else artifact mtime
  title         text,                           -- display title from __title.txt (fs-only; nullable)
  join_url      text,                           -- Teams link (SessionState.joinUrl)
  stage         text NOT NULL DEFAULT 'recording'
                CHECK (stage IN ('recording','remuxing','transcribing','noting','consolidating','done','failed')),
  stage_note    text,                           -- e.g. "3/12 segments through Gemini"
  seg_count     int,
  duration_sec  numeric(10,2),
  size_mb       numeric(10,2),
  started_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  CONSTRAINT sessions_course_stem_owner_key UNIQUE (course_id, stem, owner_user_id)
                                               -- two owners may hold the same stem (hosted multi-tenant)
);
CREATE INDEX IF NOT EXISTS sessions_course_date_idx ON sessions (course_id, session_date DESC, start_time DESC NULLS LAST);

-- ── session artifacts (recordings / notes / transcripts / timelines as rows) ──
CREATE TABLE IF NOT EXISTS session_artifacts (
  id             bigserial PRIMARY KEY,
  session_id     bigint NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('recording','notes','running_notes','transcript','timeline','audio_ogg')),
  storage_uri    text,                          -- "file:///data/recordings/…" / future "s3://bucket/…"
  rel_path       text NOT NULL,                 -- DATA_DIR-relative, keeps parity checks trivial
  mime_type      text,
  bytes          bigint,
  checksum       text,                          -- sha256 for blobs, content hash for text
  content        text,                          -- inline text for md/json artifacts (notes etc.)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,                   -- retention tombstone (video only)
  retained_until timestamptz,                   -- computed from recordRetentionDays
  UNIQUE (session_id, kind, rel_path)
);
CREATE INDEX IF NOT EXISTS session_artifacts_retention_idx ON session_artifacts (retained_until)
  WHERE deleted_at IS NULL AND kind = 'recording';

-- ── transcript segments (replaces __timeline.json / out/timeline.jsonl rows) ──
CREATE TABLE IF NOT EXISTS transcript_segments (
  id           bigserial PRIMARY KEY,
  session_id   bigint NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seg_index    int NOT NULL,                    -- 0-based 5-min bucket (segment.ts:81-82)
  offset_sec   int NOT NULL,
  file         text,                            -- source segment filename
  transcript   text NOT NULL DEFAULT '',
  visual_notes jsonb NOT NULL DEFAULT '[]',     -- [{t,note}]
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, offset_sec)
);

-- ── documents (materials + ingested notes/transcripts as searchable docs) ──
CREATE TABLE IF NOT EXISTS documents (
  id           bigserial PRIMARY KEY,
  course_id     bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'material'
               CHECK (kind IN ('material','notes','transcript','timeline')),
  session_id   bigint REFERENCES sessions(id) ON DELETE CASCADE,  -- set for kind != material
  rel_path     text NOT NULL,                   -- "Week 1/1.1 Modeling.pdf" (materials.ts)
  filename     text NOT NULL,
  week         int CHECK (week BETWEEN 1 AND 15),
  category     text NOT NULL DEFAULT 'other'
               CHECK (category IN ('syllabus','assignment','lecture-notes','reference','rubric','transcript','other')),
  description  text NOT NULL DEFAULT '',
  size_bytes   bigint,
  checksum     text,                            -- mtimeMs:size → sha256 parity with .src marker
  page_count   int,
  uploaded_at  timestamptz,
  indexed_at   timestamptz,                     -- embedding backfill watermark
  owner_user_id uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_course_kind_rel_path_owner_key UNIQUE (course_id, kind, rel_path, owner_user_id)
);
CREATE INDEX IF NOT EXISTS documents_course_week_idx ON documents (course_id, week NULLS LAST);

CREATE TABLE IF NOT EXISTS document_chunks (
  id              bigserial PRIMARY KEY,
  document_id     bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page            int NOT NULL DEFAULT 1,       -- docindex page number
  chunk_index     int NOT NULL,                 -- sub-page chunk (≈1–2k tokens)
  content         text NOT NULL,
  token_count     int,
  embedding       vector(768),                  -- dimension pinned per model; see note
  embedding_model text NOT NULL DEFAULT 'text-embedding-004',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, page, chunk_index)
);
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS document_chunks_model_idx ON document_chunks (embedding_model);

-- Vector dimension note: pin `vector(768)` (Gemini `text-embedding-004` / common open models).
-- If the model changes later, add a parallel column + rebuild rather than `ALTER TYPE` — chunks are
-- cheap to re-embed from source text. `embedding_model` lets multiple generations coexist during a
-- model swap; queries filter on it.

CREATE TABLE IF NOT EXISTS deadlines (
  id           bigserial PRIMARY KEY,
  legacy_id    text,                            -- djb2 hex from daemon.ts:1037-1042, kept for parity
  course_id    bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title        text NOT NULL,
  due          date,
  due_manual   boolean NOT NULL DEFAULT false,
  kind         text NOT NULL DEFAULT '',
  spread       boolean NOT NULL DEFAULT false,
  start_by     date,
  note         text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT '',
  confidence   text NOT NULL DEFAULT 'high' CHECK (confidence IN ('high','medium','low')),
  done         boolean NOT NULL DEFAULT false,
  done_at      timestamptz,
  user_note    text,
  stale        bigint,                           -- epoch-ms "not seen in source" marker (daemon Dl.stale is ms, not a count)
  owner_user_id uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- dlKey() + legacy id: fs can hold ~1 re-extraction twins. owner_user_id is part of the key so two
  -- owners' same-course/same-title rows never collide (pre-5b-2 this was cross-owner UPDATE corruption).
  -- Named explicitly so a fresh DB and a prod DB migrated per
  -- docs/planning/deploy-runbook-2026-10-21.md §8 carry the SAME constraint/index name.
  CONSTRAINT deadlines_course_title_legacy_owner_key UNIQUE (course_id, title, legacy_id, owner_user_id)
);

CREATE TABLE IF NOT EXISTS deadline_parts (     -- Dl.parts[] for not-yet-generated checklists
  id          bigserial PRIMARY KEY,
  deadline_id bigint NOT NULL REFERENCES deadlines(id) ON DELETE CASCADE,
  title       text NOT NULL,
  due         date,
  note        text NOT NULL DEFAULT '',
  done        boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS deadline_folds (     -- deadlines-folds.json verdicts + tombstones
  id               bigserial PRIMARY KEY,
  parent_id        bigint NOT NULL REFERENCES deadlines(id) ON DELETE CASCADE,
  child_id         bigint NOT NULL REFERENCES deadlines(id) ON DELETE CASCADE,
  status           text NOT NULL CHECK (status IN ('pending','accepted','declined')),
  chosen_parent_id bigint REFERENCES deadlines(id),   -- user's pick overrides nomination
  added_item_ids   jsonb NOT NULL DEFAULT '[]',       -- unfold: which checklist rows to remove
  enriched         jsonb,                             -- {itemId, prevText, prevDone}
  child_snapshot   jsonb NOT NULL,                    -- full Dl tombstone → restore on unfold
  folded_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, child_id)
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id          bigserial PRIMARY KEY,
  deadline_id bigint NOT NULL REFERENCES deadlines(id) ON DELETE CASCADE,
  legacy_key  text NOT NULL,                    -- djb2 id from daemon.ts mkItem()
  text        text NOT NULL,
  done        boolean NOT NULL DEFAULT false,
  done_at     timestamptz,
  manual      boolean NOT NULL DEFAULT false,
  position    int NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deadline_id, legacy_key)
);

CREATE TABLE IF NOT EXISTS activity_events (    -- replaces out/events.jsonl (status.ts:291-305)
  id    bigserial PRIMARY KEY,
  ts    timestamptz NOT NULL DEFAULT now(),
  msg   text NOT NULL,
  owner_user_id uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS activity_events_ts_idx ON activity_events (ts DESC);

CREATE TABLE IF NOT EXISTS app_settings (       -- optional: replaces settings.json (status.ts:8-25)
  key    text NOT NULL,                          -- 'recordRetentionDays', 'geminiModels', …
  owner_user_id uuid NOT NULL REFERENCES users(id) DEFAULT '00000000-0000-0000-0000-000000000001',  -- system row = seed owner; user rows overlay it (state.ts settingsLoad merge)
  value  jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_key_owner_key UNIQUE (key, owner_user_id)
);

-- ── chat history (replaces user-data/chat.json + user-data/courses/<slug>/chat.json) ──
CREATE TABLE IF NOT EXISTS chat_messages (
  id            bigserial PRIMARY KEY,
  scope         text NOT NULL,                  -- 'global' or course slug
  role          text NOT NULL CHECK (role IN ('user','assistant')),
  content       text NOT NULL,
  at            timestamptz NOT NULL,           -- message timestamp (ISO in JSON)
  owner_user_id uuid NOT NULL REFERENCES users(id) DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_scope_idx ON chat_messages (owner_user_id, scope, id);

-- ── attendance journal (replaces attended.json) ───────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id            bigserial PRIMARY KEY,
  date          text NOT NULL,                  -- new Date().toDateString() e.g. 'Tue Sep 08 2026'
  title         text NOT NULL,
  joined_at     bigint NOT NULL,                -- epoch-ms
  left_at       bigint,                         -- epoch-ms; NULL = entry still open
  owner_user_id uuid NOT NULL REFERENCES users(id) DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, date, title, joined_at)  -- join+leave land on one row
);
CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance (owner_user_id, date);

-- ── manually-left meetings (replaces left-meetings.json) ──────────────────
CREATE TABLE IF NOT EXISTS left_meetings (
  id            bigserial PRIMARY KEY,
  day           text NOT NULL,                  -- 'YYYY-MM-DD' (localDate)
  title         text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, day, title)
);

-- ── deadline rebuild manifest (replaces user-data/deadlines-meta.json) ─────
CREATE TABLE IF NOT EXISTS deadlines_meta (
  id            bigserial PRIMARY KEY,
  doc_key       text NOT NULL,                  -- '<courseSlug>/<relPath>'
  mtime         bigint NOT NULL,                -- epoch-ms
  size          bigint NOT NULL,                -- bytes
  course        text NOT NULL,                  -- course slug
  owner_user_id uuid NOT NULL REFERENCES users(id) DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, doc_key)
);

-- ── users.avatar (Gap 4: avatar cached in app DB — upload or FaceHash, no provider sync) ──
-- Additive migration; IF NOT EXISTS keeps re-applying ddl.sql idempotent.
-- Avatars are KB-scale (small uploads) so bytea is fine (bytes-out-of-PG in
-- Gap 3 was for video/document scale). avatar_synced_at is a write-timestamp
-- for cache-busting only. (avatar_source provenance existed briefly in the
-- Gap 4b provider-sync design; removed with it — dropped 2026-10-18.)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar          bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime     text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_synced_at timestamptz;

-- ── multi-tenant hardening (authentik Phase 2, hosted-platform.md §5 item 4) ──
-- Re-runnable wholesale like the blocks above: fresh DBs already carry the
-- named constraints from the CREATE blocks above; deployed DBs converge here.

-- sessions: two owners may hold the same course+stem, so the natural key
-- gains owner_user_id. Drop the old unnamed two-column unique if present,
-- then add the named composite constraint if absent (PG has no
-- ADD CONSTRAINT IF NOT EXISTS; the pg_constraint probe keeps it idempotent).
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_course_id_stem_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_course_stem_owner_key') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_course_stem_owner_key
      UNIQUE (course_id, stem, owner_user_id);
  END IF;
END
$$;

-- courses / meeting_mappings / documents (2026-10-30 owner-scope wave): the
-- natural keys gain owner_user_id exactly like sessions/deadlines before them.
-- ⚠ ORDERING on PROD: this drop is the CONTRACT step — only re-run ddl.sql
-- wholesale once the owner-scoped ON CONFLICT code is live (runbook order
-- expand → deploy → write-probe → contract; deploy/sql/2026-10-30-owner-scope).
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_slug_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'courses_slug_owner_key')
     AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                      WHERE c.relname = 'courses_slug_owner_key') THEN
    ALTER TABLE courses ADD CONSTRAINT courses_slug_owner_key UNIQUE (slug, owner_user_id);
  END IF;
END
$$;

ALTER TABLE meeting_mappings DROP CONSTRAINT IF EXISTS meeting_mappings_match_title_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_mappings_match_title_owner_key')
     AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                      WHERE c.relname = 'meeting_mappings_match_title_owner_key') THEN
    ALTER TABLE meeting_mappings ADD CONSTRAINT meeting_mappings_match_title_owner_key
      UNIQUE (match_title, owner_user_id);
  END IF;
END
$$;

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_course_id_kind_rel_path_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_course_kind_rel_path_owner_key')
     AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                      WHERE c.relname = 'documents_course_kind_rel_path_owner_key') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_course_kind_rel_path_owner_key
      UNIQUE (course_id, kind, rel_path, owner_user_id);
  END IF;
END
$$;

-- app_settings: per-user overlay. owner_user_id backfills to the seed owner
-- (DEFAULT covers existing rows — no explicit backfill needed), then the
-- key-only primary key gives way to the (key, owner_user_id) natural key.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS owner_user_id uuid NOT NULL
  REFERENCES users(id) DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_key_owner_key') THEN
    ALTER TABLE app_settings ADD CONSTRAINT app_settings_key_owner_key
      UNIQUE (key, owner_user_id);
  END IF;
END
$$;

-- ── recorder registry (recorder-split.md §3) ─────────────────────────────
-- Per-owner recorder heartbeat rows. 'inbound' = platform→svc URL (personal
-- pod); 'poll' = Electron behind NAT (commands pulled later). Only 'inbound'
-- is implemented this phase.
CREATE TABLE IF NOT EXISTS recorders (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL DEFAULT 'personal',
  mode          text NOT NULL DEFAULT 'inbound',
  endpoint      text,
  last_seen     timestamptz,
  capabilities  jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (owner_user_id, name)
);
