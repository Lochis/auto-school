# Planning: PostgreSQL + pgvector migration for auto-school

Status: implementation underway — importer (`scripts/import-fs-to-pg.ts`), `src/db/` access layer,
and the smoke suite are merged on main; this doc remains the plan of record (original planning
branch `plan/postgres-migration`).
Deliverables: this document + `docs/planning/postgres-architecture.mmd` (two mermaid diagrams:
ER + target data flow).
Companion docs (written in parallel, cross-reference them): `docs/planning/authentik-federation.md`,
`docs/planning/multi-user-architecture.md`.

Mission: replace the filesystem/JSON data layer with PostgreSQL (+ pgvector for embeddings),
keeping recordings as blobs on the PVC (later S3/MinIO), with a verifiable, reversible migration.
**Interchangeability requirement:** the fs layout and the DB must be two lossless
representations of the same information — fs → PG import AND PG → fs export both exist, and a
round-trip (fs → PG → fs′) must reproduce the tree (content + checksums + mtimes). Every table
therefore keeps the fs natural key (`slug`, `stem`, `rel_path`) or the legacy id (`djb2`), and
import captures fs mtimes (see §4.1 step 3).

**Decision (2026-12): interchangeability dropped.** Direction is fs → PG **one-way**: the fs tree
remains the blob store for recording bytes only (abstracted per `storage-backends.md` §7), while
metadata reads/writes move to PG exclusively. The PG→fs exporter (§4.1.1) is demoted to an
optional maintenance/escape-hatch script — no longer a phase gate or the rollback path of record
(§4.3). The interchangeability text above is retained as the historical rationale for the
natural-key and mtime-capture design.

**End-state data planes (product form, informs this design):**

| Data | Where | Why |
|---|---|---|
| Recording bytes (video/audio) | User's device / their own cloud — **never platform storage** | Compliance weight scales with what the platform holds; recordings of identifiable people are the heaviest asset class. The DB stores only a `storage_uri` pointer (scheme-pluggable: `file://` now, user `s3://` later). |
| Transcripts, notes, session index | Postgres, `owner_user_id`-partitioned | Same sensitivity as chat history (already accepted in PG); enables pgvector search + chat tools; KBs not GBs. |
| Users/logins, course mapping, chat history, settings | Postgres | Control plane. |

"Delete recording, keep transcript" is already the retention model: `session_artifacts` gives
each kind an independent lifecycle (`deleted_at`/`retained_until` on the recording-kind partial
index only); a user-facing "free up space" action is just that tombstone + unlink.
Per-user SQLite for content is a **fallback, not a milestone** — only needed if platform-held
text ever becomes unacceptable; PG-with-owner-partitioning is the content plane.

---

## 1. Current data model — inventory from the code (ground truth)

Everything lives under one writable root `DATA_DIR` (`AUTO_SCHOOL_DATA`, `/data` in the pod —
`src/paths.ts:5-20`; PVC `auto-school-data`, storageClass `longhorn` — `deploy/k8s/auto-school.yaml:56-68`).

### 1.1 Directory layout and consumers

| Path | Writer | Readers | Shape |
|---|---|---|---|
| `recordings/<course-slug>/<stem>.webm\|.mp4` | `consolidate.ts` | frontend `data.ts`, tools `scanCourseSessions` | `<YYYY-MM-DD>__<course-slug>[__THHMMSS\|__tag]` stem (`consolidate.ts:55-68` derives collision suffix) |
| `notes/<course-slug>/<stem>__notes.md` | `notes.ts:88-92` | frontend, chat tools | final markdown notes |
| `notes/<course-slug>/<stem>__running.md` | `notes.ts:17-19, 60` | chat tools | incremental running summary |
| `notes/<course-slug>/<stem>__transcript.md` | manual re-transcribe path | frontend `data.ts:100`, tools | transcript markdown |
| `notes/<course-slug>/<stem>__timeline.json` | `notes.ts:92` | frontend `data.ts:100-105` (segmentCount) | `TimelineEntry[]` — `{meeting, offsetSec, file, transcript, visualNotes:[{t,note}]}` (`segment.ts:13-19`) |
| `notes/INDEX.md` | `courses.ts rebuildIndex():85-129` | humans | derived — rebuildable |
| `segments/*.webm` | recorder | consolidate, retention | 5-min raw segments (deleted after consolidation / retention) |
| `out/sessions.json` | `sessions.ts:40-52` (cap 100) | frontend joinUrl index `data.ts:31-41`; status | `SessionState[]` — `{stem, title, course?, startedAt, updatedAt, stage, stageNote?, segCount?, mp4?, durationSec?, sizeMB?, joinUrl?}` (`sessions.ts:15-30`); stages: recording→remuxing→transcribing→noting→consolidating→done\|failed |
| `out/timeline.jsonl` | `segment.ts:143-145` (append) | none directly (live state) | one `TimelineEntry` JSON per line |
| `out/events.jsonl` | `status.ts:291-305` | `/status` (last 60, reversed) | activity feed `{ts, msg}` |
| `out/transcribe/`, `out/concat-*.txt` | pipeline | — | ephemeral scratch |
| `courses/<slug>/course.json` | `materials.ts:58-65` | frontend `data.ts:48-60`, daemon | `CourseConfig {semesterStart: "YYYY-MM-DD", icon?}` (`materials.ts:52-56`) |
| `courses/<slug>/materials/` (real tree) | uploads | docindex, daemon rebuild | arbitrary subpaths, sanitized (`materials.ts:88-100`) |
| `courses/<slug>/materials/materials.json` | `materials.ts:143-160` | `listManifest` | `MaterialEntry[]` — `{path, filename, week\|null, category, description, uploadedAt, size}` (`materials.ts:18-28`); week derived from folder names only (`materials.ts:76-85`); category guessed (`materials.ts:145-152`) |
| `courses/<slug>/materials/.index/<rel-no-ext>/` | `docindex.ts` (lazy) | chat tools | `page-NNN.txt` (+ `page-NNN.png` for PDF/DOCX), `.src` fingerprint `mtimeMs:size\|v2` (`docindex.ts:59-77`), `.textonly` deferred marker |
| `mapping.json` (DATA_DIR root) | daemon `/mapping` route (`daemon.ts:669-695`) | `courses.ts:5-27` (exact + normalized title match) | `{ meetingTitle: courseSlug }` (currently `{}` in repo) |
| `~/.auto-school/user-data/deadlines.json` | daemon deadlines route (`daemon.ts:1024-1065`) | frontend `/api/deadlines` | `Dl[]` — `{id (djb2 of course\|title), course, title, due\|null, kind, spread, startBy, note, source, confidence, done, doneAt, userNote?, dueManual?, stale?, parts?}` (`daemon.ts:1027`) |
| `…/deadlines-folds.json` | `daemon.ts:1066-1080` | deadlines UI | `{verdicts, pending[], folded{tombstones}}` — fold/unfold sub-task state |
| `…/checklists.json` | `daemon.ts:1082-1086` | checklist UI | `Ck[]` — `{deadlineId, course, title, items:[{id,text,done,doneAt,manual?}], updatedAt}` |
| `…/deadlines-meta.json` | `daemon.ts:1290` | rebuild pipeline | doc-hash bookkeeping for incremental rebuilds |
| `settings.json` (user-data) | `status.ts getSettings` | everywhere | `Settings` (`status.ts:8-25`): transcribe, recordRetentionDays, batchSegments, transcribeBatch, geminiModels, joinEarlyMinutes, joinPaused (+ API keys) |

Course list is **derived**, not declared: union of folders under `recordings/` + `notes/`
(`frontend/src/lib/data.ts:43-45`). Session identity is the file **stem**; time-of-day comes from
an `__THHMMSS` mp4 suffix else notes mtime (`data.ts:80-97`). joinUrl attaches by fuzzy
normalized-title match between stems and `out/sessions.json` titles (`data.ts:110-119`).

### 1.2 Queries that exist today (what must keep working)

- Course/session/artifact listing and reads — `data.ts courses()/sessions()/readText()/timelineToMd()`.
- Meeting title → course resolution: `mapping.json` manual overrides with normalized containment
  fallback (`courses.ts:5-38`), else regex parse of `"<code> --<Name> (SEC. n)"` (`courses.ts:46-56`).
- RAG-ish chat tool access (`src/pipeline/tools.ts`): `list_materials` (105), `read_document` (113,
  paged text via docindex), `view_page` (129, VLM on page PNG), `read_notes`/`list_sessions`
  (169-194 `scanCourseSessions`), `search_transcripts` (161-163, 379-405).
- **There are no embeddings today.** "Semantic search" is currently: keyword substring match over
  transcripts/timelines (`tools.ts:379-405`) and an LLM semantic-dedup pass over deadlines
  (`daemon.ts:1515-1569`). The document "index" (`docindex.ts`) is a lazy page-text/page-image
  cache for the tools, not a vector index. pgvector is therefore an **additive capability**, not a
  lift-and-shift — the importer must backfill embeddings for materials/notes/transcripts.
- Retention: sweep `recordings/` (`*.mp4|.mkv|.webm`) and `segments/` older than
  `recordRetentionDays`; `notes/` never touched (`retention.ts:1-42`); runs at daemon startup + 6h.
- Deadlines: full AI rebuild from changed materials + deterministic folds; user CRUD via POST
  (done/date/delete/fold/unfold) — `daemon.ts:1024-1340`.

### 1.3 Deployment reality

Single `Deployment` with two containers in one pod (`deploy/k8s/auto-school.yaml:70-148`):
backend daemon `:7800` (rw `/data`) and Next.js frontend `:3000` (ro `/data`, reads the fs directly
via `frontend/src/lib/data.ts`). Node 24 type-stripping runs the daemon (`package.json:8-11`);
bun is used for build scripts (`package.json:12-15`) — the access layer must work under both.

---

## 2. Proposed schema (DDL-level)

Conventions: `bigserial` PKs for internal tables; `uuid` only for `users.id` (external Authentik
identity). **Why bigserial over UUIDv7:** the dataset is small (≤ a few thousand sessions, tens of
thousands of chunks); natural keys (`slug`, `(course_id, stem)`) already exist and stay as UNIQUE
constraints; serial PKs keep index locality for bulk chunk inserts and keep URLs/DEBUG simple.
UUIDv7's advantage (distributed generation, non-enumerable public ids) matters only for
user-visible multi-tenant APIs — which Authentik-gated ids will cover later; adding `public_id`
columns then is additive. All data tables carry `owner_user_id` FK for the multi-user plan
(defaults to the single local user until federation lands).

Timestamps `timestamptz` throughout. Soft-delete (`deleted_at`) only where retention needs it.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- keyword fallback / fuzzy title match

-- ── users (stub; full design in authentik-federation.md) ──────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authentik_sub text UNIQUE,                 -- OIDC "sub" claim; NULL until first login claims the seed row
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
CREATE TABLE courses (
  id             bigserial PRIMARY KEY,
  slug           text NOT NULL UNIQUE,          -- "Java_Programming" (courses.ts slug())
  name           text NOT NULL,                 -- human name
  code           text NOT NULL DEFAULT 'GEN',   -- "26M" | "MAP" | "GEN" (courses.ts:46-56)
  icon           text,                          -- course.json icon
  semester_start date,                          -- course.json semesterStart
  owner_user_id  uuid NOT NULL REFERENCES users(id) DEFAULT '00000000-0000-0000-0000-000000000001',  -- lochis
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── meeting mappings (replaces mapping.json) ──────────────────────────────
CREATE TABLE meeting_mappings (
  id               bigserial PRIMARY KEY,
  match_title      text NOT NULL UNIQUE,        -- exact meeting title as captured
  norm_title       text NOT NULL,               -- precomputed normalized form (courses.ts:20-21)
  course_id        bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto')),
  owner_user_id    uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_mappings_norm_idx ON meeting_mappings (norm_title text_pattern_ops);
-- containment matching ("chip truncation", courses.ts:25-32) stays app-side; norm_title
-- narrows candidates. Later: trigram/GIN if the table grows.

-- ── sessions (replaces out/sessions.json + note/recording stems as identity) ──
CREATE TABLE sessions (
  id            bigserial PRIMARY KEY,
  course_id     bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  stem          text NOT NULL,                  -- "2026-08-20__Java_Programming__T190012"
  session_date  date   NOT NULL,
  start_time    time,                           -- from __THHMMSS suffix else artifact mtime
  title         text NOT NULL,                  -- raw meeting title
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
  UNIQUE (course_id, stem)                      -- natural key for idempotent upserts
);
CREATE INDEX sessions_course_date_idx ON sessions (course_id, session_date DESC, start_time DESC NULLS LAST);

-- ── session artifacts (recordings / notes / transcripts / timelines as rows) ──
CREATE TABLE session_artifacts (
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
CREATE INDEX session_artifacts_retention_idx ON session_artifacts (retained_until)
  WHERE deleted_at IS NULL AND kind = 'recording';

-- ── transcript segments (replaces __timeline.json / out/timeline.jsonl rows) ──
CREATE TABLE transcript_segments (
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
CREATE TABLE documents (
  id           bigserial PRIMARY KEY,
  course_id    bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'material'
               CHECK (kind IN ('material','notes','transcript','timeline')),
  session_id   bigint REFERENCES sessions(id) ON DELETE CASCADE,  -- set for kind != material
  rel_path     text NOT NULL,                   -- "Week 1/1.1 Modeling.pdf" (materials.ts)
  filename     text NOT NULL,
  week         int CHECK (week BETWEEN 1 AND 15),
  category     text NOT NULL DEFAULT 'other'
               CHECK (category IN ('syllabus','assignment','lecture-notes','reference','rubric','other')),
  description  text NOT NULL DEFAULT '',
  size_bytes   bigint,
  checksum     text,                            -- mtimeMs:size → sha256 parity with .src marker
  page_count   int,
  uploaded_at  timestamptz,
  indexed_at   timestamptz,                     -- embedding backfill watermark
  owner_user_id uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, kind, rel_path)
);
CREATE INDEX documents_course_week_idx ON documents (course_id, week NULLS LAST);

CREATE TABLE document_chunks (
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
CREATE INDEX document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX document_chunks_model_idx ON document_chunks (embedding_model);
```

Vector dimension note: pin `vector(768)` (Gemini `text-embedding-004` / common open models).
If the model changes later, add a parallel column + rebuild rather than `ALTER TYPE` — chunks are
cheap to re-embed from source text. `embedding_model` lets multiple generations coexist during a
model swap; queries filter on it.

**HNSW vs IVFFlat — recommendation: HNSW.**
- No training step; IVFFlat needs `CREATE INDEX … WITH (lists = n)` after sufficient rows exist and
  recall degrades badly on small/out-of-distribution corpora — our whole corpus is ~10⁴–10⁵ chunks.
- HNSW gives better recall@k and latency at our scale; its costs (slower builds, more memory) are
  irrelevant at this size.
- Incremental inserts (per-segment transcripts live, lazy material indexing) suit HNSW; IVFFlat
  partitions go stale and need periodic `REINDEX`.
- Requires pgvector ≥ 0.5 — satisfied by any current pgvector image.

### 2.1 Deadlines / folds / checklists (user-data JSON files)

```sql
CREATE TABLE deadlines (
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
  stale        int,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, title, legacy_id)         -- dlKey() + legacy id: fs can hold ~1 re-extraction twins;
);

CREATE TABLE deadline_parts (                   -- Dl.parts[] for not-yet-generated checklists
  id          bigserial PRIMARY KEY,
  deadline_id bigint NOT NULL REFERENCES deadlines(id) ON DELETE CASCADE,
  title       text NOT NULL,
  due         date,
  note        text NOT NULL DEFAULT '',
  done        boolean NOT NULL DEFAULT false
);

CREATE TABLE deadline_folds (                   -- deadlines-folds.json verdicts + tombstones
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

CREATE TABLE checklist_items (
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
```

### 2.2 Operational tables

```sql
CREATE TABLE activity_events (                  -- replaces out/events.jsonl (status.ts:291-305)
  id    bigserial PRIMARY KEY,
  ts    timestamptz NOT NULL DEFAULT now(),
  msg   text NOT NULL,
  owner_user_id uuid REFERENCES users(id)
);
CREATE INDEX activity_events_ts_idx ON activity_events (ts DESC);

CREATE TABLE app_settings (                     -- optional: replaces settings.json (status.ts:8-25)
  key    text PRIMARY KEY,                      -- 'recordRetentionDays', 'geminiModels', …
  value  jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### 2.3 Blob strategy — recordings stay OUT of Postgres

- Recordings are 100 MB–GB-class webm/mp4 (`consolidate.ts` ~1:1 VP9 stream-copies of a 3-hour
  capture). Putting them in Postgres (bytea/large objects) would bloat WAL and base backups,
  make `pg_dump`/PITR windows enormous, and still not give the one thing video playback needs:
  HTTP **Range** requests — the frontend media path streams from fs today and from S3/MinIO later,
  both of which serve ranges natively; Postgres does not.
- DB stores `storage_uri` + metadata (bytes, checksum, `retained_until`). Scheme-pluggable:
  `file:///data/…` on the current Longhorn PVC now; `s3://auto-school/…` via a MinIO/S3
  compatible layer later with zero schema change.
- Page-image PNGs from `docindex.ts` (VLM input) and the lazy `.index` bundles remain fs-derived
  caches — they are rebuildable from sources (`docindex.ts:59-77` fingerprint logic); only the
  extracted **text** gets chunked + embedded into `document_chunks`.
- Small text artifacts (notes md, timeline json, running md) are small enough to inline as
  `content` (they're the hot read path for chat tools) — no fs hit needed for search/preview.

---

## 3. Access layer

**Recommendation: Drizzle ORM + `node-postgres` (`pg`) driver, in a new `src/db/` module shared by
daemon and Next.js.**

- Works on both runtimes in play: `pg` is pure JS (no native build), runs under Node 24
  type-stripping (daemon: `package.json:8-11`) and under Bun (`bun.lock`; build scripts
  `package.json:12-15`). Prisma's engine story under Bun/mixed runtimes is the reason to avoid it;
  Kysely is only a query builder (no schema/migrations).
- Drizzle gives a typed TS schema file that mirrors the DDL above, generates SQL migrations
  (`drizzle-kit`), and keeps query code reviewable — important since parity with the fs readers is
  the whole migration.

Layout:

```
src/db/
  schema.ts        # Drizzle table defs (single source of truth for DDL)
  client.ts        # pooled client from DATABASE_URL or PG* env (node-postgres reads PGHOST/
                   #   PGUSER/PGPASSWORD/PGDATABASE natively — the k8s secret feeds these directly)
  queries/         # read paths replacing fs scans
    courses.ts     #   courses(), courseConfig()           ← data.ts:43-60, materials.ts:52-65
    sessions.ts    #   sessions(course), timeline, joinUrl ← data.ts:62-130
    deadlines.ts   #   deadline list/folds/checklists      ← daemon.ts:1024-1340
    search.ts      #   semantic_search(course?, q, k) — pgvector <=> + pg_trgm fallback
  writes/          # daemon-side upserts
    pipeline.ts    #   updateSession, insertSegment, upsertArtifact
    deadlines.ts
    retention.ts
```

Write-path moves (daemon):
- `sessions.ts updateSession()` → `UPDATE sessions … ; INSERT … ON CONFLICT (course_id, stem)`
  (the 100-row cap in `sessions.ts:40-48` becomes a query LIMIT, not data loss).
- `segment.ts` keeps its `timeline.jsonl` append as an in-class crash journal, then inserts
  `transcript_segments` rows per batch (`segment.ts:143-145` stays; add mirroring write).
- `notes.ts finalizeNotes()` writes the md file (Phase ≤3) **and** upserts `session_artifacts`.
- `consolidate.ts` final artifact → `session_artifacts(kind='recording', storage_uri=file://…)` +
  `sessions.stage='done'`.
- `courses.ts mappingLookup()` → `meeting_mappings` SELECT (normalized containment in app code,
  unchanged semantics, `courses.ts:22-32`).
- `retention.ts` → SELECT recordings with `retained_until < now()`, delete blob via fs/S3 client,
  set `deleted_at` — audit trail the unlink loop (`retention.ts:24-38`) never had.

Read-path moves (frontend):
- `frontend/src/lib/data.ts` fs scans become `src/db/queries/*` SELECTs; Next.js server components
  and `/api/*` routes call them. The daemon stays the writer of record; the frontend stops reading
  the PVC entirely (its ro `/data` mount `deploy/k8s/auto-school.yaml:142` can be dropped in Phase 4).
- `search_transcripts` tool (`tools.ts:379-405`) gains a pgvector path: embed query →
  `ORDER BY embedding <=> $q LIMIT 8`, falling back to the existing substring scan for
  no-DB/dev mode. `read_document`/`view_page` keep using the fs `.index` page bundles (unchanged).
- New chat tool `semantic_search(course?, query)` for materials+notes+transcripts in one shot.

---

## 4. Migration strategy (existing JSON/fs data)

### 4.1 Importer

One-shot script `scripts/import-fs-to-pg.ts` (run with `node` or `bun`, idempotent, re-runnable):

1. Seed the `lochis` user (fixed UUID `…0001`, `role=owner`, `authentik_sub=NULL` — claimed
   on first Authentik login; every row below gets `owner_user_id = <lochis>`). Upsert `courses`
   from the folder union (`recordings/` ∪ `notes/` ∪
   `courses/` — superset of `data.ts:43-45`) + `course.json` (icon, semesterStart).
2. `mapping.json` entries → `meeting_mappings` (exact + precomputed `norm_title`).
3. Walk `recordings/<course>/` and `notes/<course>/` per `data.ts:62-130` rules → upsert
   `sessions` (stem, date, time from `__THHMMSS` else notes mtime) + `session_artifacts`
   (kind from suffix: `__notes.md`/`__running.md`/`__transcript.md`/`__timeline.json`/video ext;
   inline `content` for md/json; sha256 + size for blobs; `retained_until` = mtime +
   recordRetentionDays). **Capture mtimes:** set `sessions.started_at` and each artifact's
   `updated_at` to the fs mtime (NOT `now()`) — the `__THHMMSS`-less time-of-day fallback
   (`data.ts:80-97`) depends on them. Collision-suffixed
   stems import as-is (they're already unique).
4. `__timeline.json` → `transcript_segments` rows (offsetSec, transcript, visualNotes).
5. `courses/<slug>/materials/` walk + `materials.json` manifest merge (`materials.ts:143-160`
   precedence rules) → `documents(kind='material')`.
6. `user-data/deadlines.json` → `deadlines` (keep `legacy_id`); `-folds.json` → `deadline_folds`;
   `checklists.json` → `checklist_items` (legacy_key = item id).
7. `out/sessions.json` → `UPDATE sessions SET join_url, stage, duration… WHERE (course,stem)
   matches title fuzzy-index` — import what matches; leave the rest (journal rows without fs
   artifacts become sessions with stage only).
8. `out/events.jsonl` → `activity_events`: import **all** lines (bounded: it's append-only,
   small); keep the `/status` last-60 slice as a query, not a data decision. If the file is
   unavailable pre-migration, the loss is accepted explicitly (cosmetic feed only).
9. Embedding backfill (separate subcommand `--embed`, resumable via `documents.indexed_at`):
   chunk material page text (reusing `docindex.ensureIndex()` output), notes, transcripts →
   `document_chunks` + embeddings.

Idempotency: every insert is an upsert on the natural key — `(slug)`, `(course_id, stem)`,
`(session_id, kind, rel_path)`, `(course_id, kind, rel_path)`, `(course_id, title)`,
`(deadline_id, legacy_key)`. Re-running converges; deleted-on-disk files are **not** purged
without `--prune` (explicit, logged).

### 4.1.1 Exporter (reverse direction — optional maintenance/escape-hatch script)

**Demoted (2026-12, see decision note at top):** no longer the interchangeability guarantee, a
phase gate, or the rollback path of record (§4.2/§4.3) — an optional maintenance/escape-hatch
script only; not required for any phase below. If run (`scripts/export-pg-to-fs.ts`, node or
bun, idempotent) it regenerates the full DATA_DIR tree from the DB alone:
- `courses` → `courses/<slug>/course.json`; `meeting_mappings` → `mapping.json`;
  `deadlines`/`deadline_folds`/`checklist_items` (via `legacy_id`/`legacy_key`/`child_snapshot`)
  → the three `user-data/*.json` files byte-identical to the originals.
- `session_artifacts` → files at `rel_path` (content from the `content` column for text; blobs
  streamed from `storage_uri`); file mtimes restored from `updated_at`.
- `transcript_segments` → `__timeline.json`; `sessions` → `out/sessions.json` (top 100 by
  recency, matching the current cap semantics).
- NOT exported (derived/rebuildable by design): `notes/INDEX.md`, `.index` caches, docindex
  page PNGs, `out/transcribe/` scratch. `out/timeline.jsonl` journal rows and `sessions.json`
  rows beyond the cap are accepted losses (live state, see §6).

### 4.2 Verification checklist

Round-trip export gate dropped with the interchangeability decision (§4.1.1); the checks below
still gate Phase 3. Mtime capture at import remains required only for the `sessions.started_at`
time-of-day fallback (`__THHMMSS`-less stems, `data.ts:80-97`).

- Counts: courses, sessions/artifacts per course, segments, documents vs a fs manifest
  (`find | wc`) — importer prints a parity table.
- Blob checksums: sha256 of every recording matches `session_artifacts.checksum` (sample or full).
- Text parity: `readText()` output == `session_artifacts.content` for N sampled sessions;
  `timelineToMd()` over DB segments == current fs rendering (`data.ts:158-175`).
- joinUrl resolution: same stem→URL mapping as `data.ts:110-119` fuzzy pass.
- Deadlines round-trip: GET `/api/deadlines` pre/post identical (ids via `legacy_id`).
- Search parity: fixed battery of `search_transcripts` queries returns the old substring hits
  (plus semantic extras); semantic spot-checks on materials ("which week covers X", page cites).
- Load: frontend courses/sessions screens render from DB with correct ordering
  (date DESC, time — `data.ts:130`).

### 4.3 Rollback

Two regimes, split at Phase 4 (fs stops being written there — see the 2026-12 decision note at
top; the exporter is an escape hatch, not the rollback path of record):

- **Pre-Phase-4:** the migration is additive — fs stays the source of truth, the DB is
  disposable (re-importable from fs at any time). Every phase gates on an env flag
  (`DATA_BACKEND=fs|dual|db`); rollback = flip the flag + redeploy. Drop the DB entirely to
  "factory reset". Never delete fs data during import.
- **Post-Phase-4:** fs no longer holds a complete copy of the metadata, so rollback is a
  **Postgres restore** — nightly `pg_dump` to MinIO + Longhorn snapshots of `auto-school-pg-data`
  (§5). Recording blobs survive on the storage layer either way (`storage-backends.md` §7).

### 4.4 Phased cutover

| Phase | State | Exit criteria |
|---|---|---|
| 1 — Import (read-only DB) | Importer runs nightly; parity dashboards compare fs vs DB | Parity checklist green for 2 consecutive runs |
| 2 — Dual-write | Daemon writes fs (primary) **and** DB in one code path (`DATA_BACKEND=dual`); reads still fs | No parity drift over ≥1 week incl. a full class cycle (record→consolidate→notes) |
| 3 — DB reads | Reads switch to `src/db/queries` (`DATA_BACKEND=db`); fs writes continue as backup; importer keeps repairing drift | Frontend + chat tools stable; semantic search live |
| 4 — fs write removal | Daemon writes only DB; blobs only via storage layer; retention via `retained_until`/`deleted_at`; frontend drops ro `/data` mount | 30 days clean; PVC remains live blob store for recordings (`storage-backends.md` §7 deviation); fs metadata tree archived read-only |

---

## 5. Deployment (k3s homelab)

- **Operator: none — plain Postgres pod** (decision 2026-10: single-instance homelab workload;
CNPG's CR/rolling-upgrade/PITR machinery was judged not worth a new operator + ImageVolume
plumbing for one database that Longhorn already snapshots). `deploy/k8s/postgres.yaml`:
  - `Deployment` `auto-school-pg` (strategy `Recreate`, RWO PVC), image `pgvector/pgvector:pg17`
    (official Postgres 17 with pgvector baked in — no extension build), `pg_isready` readiness +
    liveness probes, 250m/512Mi requests.
  - PVC `auto-school-pg-data` 10Gi `storageClassName: longhorn` (recordings stay on the app PVC;
    this holds only metadata + chunks + embeddings — text-scale, not video-scale).
  - Service `auto-school-pg:5432`, namespace `auto-school` (app-adjacent, cloudreve pattern).
  - Credentials: `Secret auto-school-pg` (`PGUSER`/`PGPASSWORD`) created out-of-band via
    `kubectl create secret` — no creds in git. The app Deployment gets `envFrom: secretRef:
    auto-school-pg` plus explicit `PGHOST=auto-school-pg`, `PGDATABASE=autoschool`.
- **Extensions**: `CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;` run in the first drizzle
  migration (schema migration Job before rollout).
- **Backups**: no barman/PITR — nightly `pg_dump` CronJob to MinIO + Longhorn recurring snapshots
  (same posture as the rest of the homelab; WAL-corruption risk accepted after the cloudreve
  incident — the DB stays re-importable from the fs tree until Phase 4 cutover, which is the real
  safety net).
- **Migrations**: `drizzle-kit` migrations applied by a Kubernetes `Job` (init step in the deploy
  script) before each rollout.

---

## 6. Risks / open questions

- **Transcription is the one flow where recording bytes touch platform infra** (audio segments →
  Gemini). Today: own infra + own API key, fine. In product form: BYOK (see
  `future-product-goals.md`) sends audio user-key → Gemini directly; the platform only persists
  the resulting text. Transient processing, no persistence — keep it that way.
- Per-user SQLite for transcripts/notes (content plane split) — parked as fallback only, per the
  end-state table above; do not over-invest in PG-specific features on content tables
  (e.g. skip `pg_trgm` beyond what title matching needs).

- Embedding quota/cost: backfill of all materials+transcripts is a one-time burst — schedule it
  off-class-hours; `documents.indexed_at` makes it resumable.
- `pg_trgm`/normalized-title matching parity for `mapping.json` containment semantics
  (`courses.ts:25-32`) — keep app-side matching, DB just narrows candidates.
- The in-pod frontend currently reads the fs directly (`data.ts`); moving reads to DB removes the
  same-pod coupling — but the media (Range) route must keep pointing at the storage layer.
- Timeline jsonl remains a crash journal in Phase 2+ — decide in Phase 4 whether the append is
  kept as belt-and-braces or removed.

### 6.1 Corrections discovered during the dev import run (2026-10-16)

Implemented in `scripts/import-fs-to-pg.ts` + live dev DB; folded back into DDL/schema:

- `deadlines.stale` holds epoch-ms (frontend does `new Date(it.stale)`) — declared `int` in the
  original DDL, **fixed to `bigint`** in `ddl.sql`/`schema.ts` + ALTER on the dev DB.
- `UNIQUE (course_id, title)` on `deadlines` dropped fs-legal `~1` re-extraction twins → relaxed
  to `UNIQUE (course_id, title, legacy_id)`; dlKey() uniqueness stays app-side (as on fs).
- `settings.json` lives at the DATA_DIR **root**, not `user-data/` (§1.1 said user-data).
- Undocumented files exist on the real PVC: `attended.json`, `left-meetings.json`,
  `user-data/chat.json`, `user-data/deadlines-meta.json` → imported as opaque `app_settings`
  rows; none were in the §1.1 inventory.
- `transcript_segments.visual_notes[].t` is a `"m:ss"` **string** in fs data, not a number
  (schema `$type` corrected; stored as-is).
- `recordRetentionDays=0` means "keep forever" — `retained_until` must be NULL then, not
  mtime+N; importer uses explicit-positive-setting-else-365d.
- One recordings subdir (`recordings/<course>/2026-09-trim-orig`) holds pre-trim originals —
  flat-file walk skips it (data.ts semantics); decide retention for it explicitly later.
- `deadline_folds.folded` is a dict of tombstones; accepted verdicts have no tombstone and no
  child row — importer logs + skips them (nothing to reconstruct).
