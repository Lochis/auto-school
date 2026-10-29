# Platform AI generation — 5b-2(c) implementation map

Status: **IMPLEMENTED + DEPLOYED 2026-10-29** (5b-2c). See also ingestion-api.md §3/§4, hosted-platform.md §1.6/§5b.

## Goal
Move notes/checklist/deadline GENERATION (and the tool surface they call) to the platform back end,
so the recorder is capture+submit only. Transcribe STAYS on the recorder (needs ffmpeg).

## Gating decisions (D1–D5)
- **D1 Keys** — new `src/db/llm-keys.ts`: resolve `GEMINI_API_KEY`/`GLM_API_KEY` as
  env → `app_settings` system row → undefined. **Never** read `DATA_DIR/settings.json`
  (platform has no mount; user keys stay keychain-side for hosted). Personal pod keeps its fs path.
- **D2 Materials** — PG artifacts, not blobs, not recorder fetch. `documents` + `document_chunks`
  already hold material page text; `listMaterials` is already PG-first. Recorder media route is an
  escape hatch only. Text-only `POST /api/ingest/material` is a later 5b-2c-2 (Electron).
- **D3 transcribe** — STAYS on recorder (`transcribe/transcribe.ts` spawns ffmpeg/ffprobe; platform
  image has neither).
- **D4 notes** — MOVE (cheapest): `foldSegments` + `finalizeNotes` (`src/pipeline/notes.ts:57-155`)
  are pure PG+LLM; fs tail is only defaults/notify/embed-kick.
- **D5 checklist + deadline rebuild** — MOVE after extraction: checklist gen inline in
  `src/daemon.ts:2284-2338`; deadline rebuild inline `:1849-2224` (~375 lines, only fs input is
  `snapshotDocs` stat walk `:1855-1875`).

## Ingest delta (no blobs)
- Materialize `timeline[]` → `transcript_segments` (today only an artifact blob, so the embed sweep
  sees nothing) + optional `segments[]` with offsets.
- Text-only `POST /api/ingest/material` later for Electron.

## Hard constraints / blockers
1. **`frontend/Dockerfile:15` copies only `src/db/`** — every new module must live under `src/db/`
   and import only `next`/`pg`/`react`/markdown deps. Any `src/pipeline` import is a build break.
2. **`src/status.ts` is unbundleable** (module-level `initModelQuotas()`, fs settings) — split an
   LLM client into `src/db/llm.ts`; `pipeline/llm.ts` delegates to it, keeping quota hooks.
3. **`documents` is system-owned + the OWNER-const embed bug** (`ingest-embed.ts:26/:111`,
   ingestion-api.md §3a.1) MUST be fixed before PG doc sourcing, else cross-owner leak / empty results.
4. **`embedPendingSessions()` is a silent no-op on the platform today** — resolves
   `geminiApiKey(dataDir)` fs-first, which fails post-cutover with no env key. Fix with D1.

## Known quality risk
PG is a filtered corpus: only EMBEDDABLE exts chunked, PDFs need `pdftotext` (recorder), scanned
pages skipped, nothing chunked post-cutover until embed is fixed. Deadline sweep reads every page →
may see less than the daemon. Mitigation: coverage probe + "no indexed text" tool warning +
media-route/poppler fallback.

## Implementation split
- **A — runtime enablement**: `src/db/llm-keys.ts`, `src/db/llm.ts` (+ `pipeline/llm.ts` delegate),
  manifest env (`PLATFORM_AI`, keys), `runToolPg`, PG `getCourseConfig`, fix OWNER-const embed bug.
- **B — generator extraction**: `src/db/gen/{tools,deadlines,checklist,notes,doc-source}.ts` +
  daemon parity harness.
- **C — routes + verify**: deadlines/checklists route dbReads branches for rebuild/generate, new
  notes-generate route (NOT on /ingest — keep ingest fast/fail-soft), owner audit, daemon-less
  acceptance test.
