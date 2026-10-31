# Planning: member-created courses (close the onboarding dead-end)

Status: **design** (not landed). Fresh signups get a planner with nothing in it and no way to
add a course: `POST /courses/create` 401s for anyone but the seed owner
(`src/daemon.ts:1764`, wave E). The DB has supported per-owner courses since the 2026-10-30
wave — the gate, not the schema, is the blocker. This doc designs the relax.

Why wave E gated it: course create was a *destructive fs op* (mkdirs under the one shared
`DATA_DIR`, `security-hardening.md:105`). The fs motivation dies if member courses are
**PG-only** — which is exactly the v1 cut proposed here.

## 1. What changes

- **Gate**: `src/daemon.ts:1764` `seedOwnerOnly()` → any authenticated member
  (`curOwner()` already resolves per request via `daemonUserHeaders()`). The frontend route
  (`frontend/src/app/api/courses/create/route.ts:8`) already `requireUser()`s — no change.
- **Create path**: today the handler 409s on fs collisions (`src/daemon.ts:1771`), mkdirs
  `recordings|notes|materials` dirs (`:1780`) and writes `course.json` (`:1782`). Members skip
  ALL of that (fs belongs to the seed — see §2) and get the PG upsert only:

  ```ts
  // member branch (daemon, after safeSlug + semesterStart validation):
  await upsertCourseConfig(slug, s ? { semesterStart: s } : {}); // src/db/writes.ts:88
  //   → insert ... on conflict (slug, owner_user_id) — stamps curOwner()
  return send(200, { ok: true, slug });
  ```

- **Slug collisions across owners become legal** — `courses_slug_owner_key UNIQUE (slug,
  owner_user_id)` (`src/db/schema.ts:56`, `ddl.sql:38`) already allows "Java_Programming" × 2
  owners. The 409 fs check must NOT apply to members (it would false-positive against the
  seed's folders); the PG conflict upsert is the only arbiter they need.

**Every course-lookup path, and its owner scoping** (verified — no slug-only lookups remain
on the PG side):

| Lookup | Site | Owner-scoped? |
|---|---|---|
| course list (daemon tools) | `src/pipeline/tools.ts:96` `resolveCourses` | ✅ `curOwner()`; fs union folded in for seed owner only (`:102`) |
| course list / meta (reads) | `src/db/queries/courses.ts:29,42` | ✅ owner REQUIRED by contract |
| course list (AI tools, PG) | `src/db/gen/tools.ts:261,268` | ✅ |
| deadline gen course scan | `src/db/gen/deadlines.ts:147` | ✅ |
| doc source for gen | `src/db/gen/doc-source.ts:82-84` | ✅ (slug AND owner in the join) |
| sessions by course | `src/db/queries/sessions.ts:122,134,146` | ✅ |
| notes by session | `src/db/queries/notes.ts:25,41` | ✅ |
| session id resolve (gen) | `src/db/gen/notes.ts:167` | ✅ |
| course upsert / id | `src/db/writes.ts:32-40` | ✅ arbiter `(slug, owner_user_id)` |
| config upsert | `src/db/writes.ts:88-101` | ✅ |
| rename / delete rows | `src/daemon.ts:1751-1753,2249` | ✅ `where slug=$1 and owner_user_id=$2` |
| chat history | `src/db/state.ts:67-104` | ✅ `(scope, owner_user_id)` |
| vector/keyword search | `src/pipeline/tools.ts:562,758,772` | ✅ `vectorSearch({owner})` |
| chat course validation | `src/pipeline/tools.ts:566` `known.includes(slug)` | ✅ via resolveCourses |

## 2. The daemon-fs question (per-owner DATA_DIR is P2 — design must not need it)

`DATA_DIR/courses/<slug>/` is the seed's fs. A member course has no dir; every daemon path
that *touches* it must be PG-first or stay seed-only:

| Daemon path | fs dependency | v1 verdict |
|---|---|---|
| `/courses` create | mkdirs + fs 409 check | **PG-only branch for members** (§1) |
| `/courses/<slug>/chat` (`:2173`) → `runTool`/`execTool` | see tool rows below | ✅ **member-usable** |
| └ `list_deadlines` / `list_checklists` | PG-first, fs fallback (`src/pipeline/tools.ts:593,633`) | ✅ PG answers, fs fallback inert (no member file) |
| └ `list_courses` / `week_overview` | `resolveCourses` PG-first; per-course fs `getCourseConfig`+`listMaterials` counts (`:478-507`) | ✅ works; counts show 0. Gap: `getCourseConfig` (`materials.ts:72`) is fs-only → seed owner's `semesterStart` would leak INTO the member's prompt. Fix: read `courseMeta()` (PG) for non-seed owners |
| └ `list_materials` / `read_document` / `view_page` | **fs only** (`pipeline/tools.ts:679-712`, docindex `readDoc`) | ⚠️ returns "no materials uploaded" — honest, correct for an empty course |
| └ `read_notes` / `list_sessions` | PG `readSessionContent`/`scanCourseSessions` when pgConfigured (`:720-753`) | ✅ PG-first; empty for members (no sessions) |
| └ `search_transcripts` / `semantic_search` | pgvector + DB keyword (`:754-787`) | ✅ PG-only when configured |
| `/courses/<slug>/materials` POST/upload (`:1541`), DELETE (`:1604,1617`), material transcribe (`:1632`) | **fs writes REQUIRED** (`materials.ts:62` COURSES_ROOT, `.index/` page cache, manifest) | 🚫 **seed-only for v1.** Uploads need a per-owner dir layout (or blob storage); both are recorder-split/P2 work |
| `/courses/<slug>/materials` GET (`:1537`) | fs listing | 🚫 keep seed-only read? No — it 401s nobody today; see §3 (add owner check) |
| `/courses/<slug>/doc` preview (`:2152`) | `readDoc` fs | 🚫 member courses have no files; add owner check (§3) |
| study-sheet (`:1436`) | reads fs topic header, **writes** `MATERIALS_DIR` + PDF + `registerMaterial` | 🚫 seed-only v1 (fs write, manifest coupling) |
| `GEN_RE` save-AI-note (`:1405`) | `writeFileSync` into materials + manifest | 🚫 seed-only v1 (same reason) |
| `/courses/<slug>/config` PUT (`:1688`) | `setCourseConfig` fs + PG mirror | ➖ **relax for owner**: PG mirror is authoritative (`upsertCourseConfig`); for members write PG only, skip the fs `course.json` |
| `/courses/<slug>/rename` (`:1715`) | renames 4 fs roots | 🚫 seed-only v1 (fs rename is the operation; a PG-only rename of a member course is WP3 polish — no fs to break, but rel_path rewrites assume fs history members don't have) |
| `/courses/<slug>` DELETE (`:2234`) | rm fs roots, **PG delete already owner-scoped** (`:2249`) | ➖ **relax for owner**: member branch skips fs entirely (guard: PG session/document count = 0 instead of empty-dir check) |
| `/media/*` (`:2289`) | streams shared DATA_DIR | 🚫 stays `seedOwnerOnly()` (wave D — no per-owner tree) |
| recorder surface (`/join`, `/scan`, `/ingest`, mapping/settings writes, `:847-1243`) | recorder fs | 🚫 untouched, seed-only (per-user recorder = hosted-platform P2) |

**v1 cut in one line**: members get create + chat + deadlines/checklists (incl. AI generation
over PG docs — `src/db/gen/deadlines.ts`/`checklist.ts` are owner-ALS-scoped and fs-free, and
`frontend/src/app/api/deadlines|checklists/route.ts` already run them per user). Members do
NOT get uploads, materials, study-sheets, saved AI notes, media, or anything recorder.

## 3. Security invariants

1. **Owner-scoping on every touched query** — the §1 table is the list. Nothing new reads by
   slug alone; `upsertCourseConfig`/`courseId` stamp `curOwner()` from the request ALS.
2. **New cross-tenant gap the relax creates**: daemon slug-bearing GETs (`materials` GET
   `:1537`, `doc` `:2152`, chat GET/POST `:2173`, `study-sheet` `:1436`, config GET `:1686`,
   transcribe `:1631`) never verify the slug belongs to `curOwner()` — today that's harmless
   (fs reads of the seed's own tree + owner-scoped PG). After the relax, a member hitting
   `/courses/<seed-slug>/doc` would read the SEED's material text. **Required companion fix**
   (WP1): every slug-bearing handler starts with

   ```ts
   const owns = curOwner() === OWNER || (await listCourses(curOwner())).includes(slug);
   if (!owns) return send(404, { error: "unknown course" });   // 404, not 403 — no existence leak
   ```

3. **`safeSlug`** (`src/paths.ts:27`) stays on create AND rename for every caller — members
   get no loosening (traversal/`\0`/case rules are fs-inherited but keep output uniform).
4. **Recorder control surface stays seed-only** — every existing `seedOwnerOnly()` gate in
   the `:847-1243` block, plus `/media/*`, materials upload/transcribe, study-sheet, GEN_RE.
   The relax touches exactly three gates: create (→ member), config PUT + delete (→ owning
   member via the §3.2 check).
5. **Delete/rename/config/materials matrix**:

   | Op | Seed owner | Owning member | Why |
   |---|---|---|---|
   | config PUT | ✅ (fs+PG) | ✅ PG-only | icon/semesterStart are PG columns; fs copy is seed parity only |
   | DELETE | ✅ | ✅ PG-only, content-guarded | cascade is FK-clean; member has no fs roots to rm |
   | rename | ✅ | 🚫 v1 | PG-only rename is safe but UI/backrefs polish; low value pre-materials |
   | materials (all) | ✅ | 🚫 | fs writes (§2) |

## 4. `users.role` — keep it informational

`users.role` now defaults `'member'` (97a3c88). **Recommendation: no gate reads it.** The
only owner test stays identity-based: `curOwner() === SYSTEM_OWNER` (seed row's explicit id,
`src/db/writes.ts` OWNER). Role-as-gate would (a) re-introduce a second tenant model to
reason about, (b) break the seed row if anyone flips its column, (c) buy nothing — there is
no admin tier. Revisit only when a real admin role ships (settings writes for non-seed ops,
moderation).

## 5. Rollout — straight relax, small WPs

No feature flag: the surface is additive (members had *nothing*; seed behavior is
byte-identical), PG-only, and reversible by re-adding one line. Split:

| WP | Files | Content |
|---|---|---|
| WP1 — owner check | `src/daemon.ts` | shared `ownsCourse(slug)` helper; wire into every `/courses/<slug>/*` handler (§3.2). **Land first — hardens even pre-relax** |
| WP2 — create relax | `src/daemon.ts` (`:1763`), `frontend/src/app/course-new.tsx` | member branch: safeSlug → PG upsert → 200; fs checks/mkdirs seed-owner-only. UI: copy tweak (panel is already member-visible) |
| WP3 — config/delete relax | `src/daemon.ts` (`:1688,2234`) | owner-scoped PG-only branches per §3 matrix |
| WP4 — chat seed-start leak | `src/daemon.ts:2197`, `src/pipeline/tools.ts:478` | `courseMeta()` (PG) instead of fs `getCourseConfig` for non-seed owners (semesterStart in prompts) |

WP1 is the only non-trivial review; WP2 is ~20 lines. tsc (`bunx tsc --noEmit`) + manual:
member creates a course, seed's course list unchanged (`listCourses(SYSTEM_OWNER)` excludes
it), second member can create the same slug.

## 6. Explicit v1 member experience (honest limits)

A fresh signup can, end-to-end: **create a course** (name + optional semester start) → it
appears on the Courses page (`listCourses` PG, `frontend/src/lib/backend.ts:94`) → **add
deadlines** (manual entries; rebuild runs the PG doc generator but finds 0 docs — fine) →
**build checklists** from those deadlines (`src/db/gen/checklist.ts`, owner-scoped, no fs) →
**chat with the course AI** (global + per-course): deadlines/checklists/course list come from
PG; `semantic_search`/`search_transcripts` work (empty index → honest "no matches");
`web_search` works if FIRECRAWL is configured. The model will truthfully say there are no
materials/sessions yet.

**Not in v1**: material uploads (fs), study-sheets + saved AI notes (fs writes), recorded
sessions/notes (recorder is seed-only until per-user recorder, hosted-platform.md P2),
media playback, embeddings. The course page's materials tab will be permanently empty —
surface a "uploads coming soon" hint there rather than a broken upload button.

## Open questions

- `listCourses()` per request for `ownsCourse` — fine at this scale; cache if the Courses
  page ever fans out.
- Member-created slugs that LATER collide with a seed fs folder (seed then creates the same
  slug): fs 409 fires only for the seed — correct, but rename flows for the seed never see
  the member's PG row. Acceptable; PG arbiters hold.
- Per-owner materials layout (`DATA_DIR/users/<id>/courses/<slug>/materials/`) vs blob
  storage for v2 uploads — decide in recorder-split terms, not here.
- Should member delete hard-block while a checklist references the course? Cascade handles
  it; UI confirmation copy only.
