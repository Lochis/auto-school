# auto-school — agent notes

This repo (branch `ui-overhaul` for the UI modernization work) has a Stitch-driven frontend overhaul.
Before extending the UI, read:

- `docs/OMITTED_UI_FEATURES.md` — deferred features (⌘K palette, probe quotas, PID chip, etc.)
  AND the already-shipped list (so you don't re-implement).
- `stitch/ANALYSIS.md` — the design spec extracted from the mockups (design tokens, per-screen
  breakdown, feature inventory). Mockups live in `stitch/stitch_ui_modernization_project/*/`.
- `stitch/QA-REPORT.md` + `stitch/QA-CONFIRM.md` — visual QA findings and post-fix verification.

Architecture notes:
- Frontend: Next.js app router in `frontend/`. Design tokens in `frontend/src/app/globals.css`
  (`:root`), shared primitives (Panel, StatCard, Badge, SegmentedTabs, Toggle, Stepper, ProgressRing,
  etc.) in `frontend/src/components/ui.tsx`. Per-screen css files: `*-ui.css`.
- Backend daemon serves data on :7800; `frontend/src/app/api/*` proxy to it. Never invent endpoints —
  check the api routes + `src/` first (payload shapes mirror `src/status.ts`, `src/daemon.ts`,
  `src/pipeline/materials.ts`).
- The frontend reads filesystem data via `DATA_DIR` (`AUTO_SCHOOL_DATA` env): recordings/, notes/,
  user-data/deadlines.json, mapping.json, courses/<slug>/course.json. See `frontend/src/lib/data.ts`.