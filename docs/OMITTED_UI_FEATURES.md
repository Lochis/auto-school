# Omitted / Deferred UI Features — ui-overhaul (2026-10-07)

This is the "would-be-great-to-have" list from the Stitch UI modernization project
(`stitch/stitch_ui_modernization_project/*/screen.png`, spec: `stitch/ANALYSIS.md`).
The overhaul deliberately shipped only what has a real data source. Everything below
was deferred — **do not re-implement the already-shipped list at the bottom.**

## Deferred (needs backend support or a deliberate product decision)

| Feature | Mockup screen | Why deferred / what it needs |
|---|---|---|
| ⌘K global quick-filter / command palette | all (navbar pill is a visual stub) | frontend-derivable (filter courses + deadlines client-side). No component was built. Best candidate for next round. |
| `● set: settings***xxxx` per-key status in API vault | settings_model_pipeline | settings API returns secrets masked already (`settings***2NRw`-style?) — check `/api/settings`; if the value shape allows it, display it beside each key label. Currently key wells show masked value + `Set` + `use env` only. |
| `⟳ Probe Quotas` action + `● All Healthy` header | settings_model_pipeline | needs a daemon endpoint that forces quota probing. Currently table shows real model quota state from `/api/models`; no probe action. |
| Purge Raw Segments (destructive) | settings_model_pipeline skeleton | needs a daemon endpoint (`/purge` or similar). UI-only button would be dangerous — do NOT add without it. |
| OAuth Token Exchange / Docker Keyring card (`SYNCED` pill) | settings_model_pipeline | env/daemon-gated (graph device-code flow). Revisit when a vault/keyring exists in the deployment. |
| Team Protocols panel + "Add to Team Policy" callout in chat | course_ai_assistant_knowledge_chat | no data source for team policy documents. Would need a new api route + storage. |
| Web-search toggle in chat composer | course_ai_assistant_knowledge_chat | chat API has no web/tool flag. The composer renders `🌐 Web off` as a static chip. |
| "Add file" chat attachment | course_ai_assistant_knowledge_chat | no attachment support in `/api/courses/[slug]/chat`. A visual `📎 Add file` chip exists; wire to real upload when supported. |
| Real caption/subtitle rendering in audio player | course_sessions_transcripts | player has the caption button + transcript data; subtitle overlay rendering inside the <video> was not implemented. |
| Word counts on transcript rows (`12 segments · 1,480 words`) | course_sessions_transcripts | counts only segments now; word count needs transcript text length (easy — split on whitespace). |
| `.index` hidden/system folder row in materials tree | course_materials_file_explorer | only shows when the backend index cache dir exists under a course. Nothing to do app-side. |
| Autopilot Target / `attended — persisted` / `not joined · queued` badges | schedule_automation_dashboard | fully data-driven from the daemon calendar scan (`out/calendar-events.txt`). Renders when a live daemon has scan data. |
| Timeline strip day-view + current-time red line + legend | schedule_automation_dashboard | same — gap is data (live scan), not UI. Verify with the real daemon before touching. |
| Activity Stream mini-stats (GEMINI TOKENS TODAY / STORAGE USED) | schedule_automation_dashboard | hidden when `/api/backend` detail lacks those keys. Screen renders them if present. |
| `PID: nnn` chip in daemon bar | schedule_automation_dashboard | `/api/backend` status has `pid` — the daemon-bar component just doesn't render it. Trivial fix. |
| Avatar button / user identity (+ notification badges) | all | no auth/user model in the frontend. The navbar avatar is a static circle. |
| Drag-to-reorder model pills in failover chain | settings_model_pipeline | reorder implemented via arrow buttons; true drag & drop was not. |

## Notes for future agents

- **Q&A artifacts**: `stitch/QA-REPORT.md` (pre-fix visual findings) and `stitch/QA-CONFIRM.md`
  (post-fix verification). Read them before restructuring anything — several P2 polish items
  from QA-CONFIRM remain open: session-action-bar compactness, deadline row density, materials
  category chips vs plain text, settings config-bar stickiness, footer-bar ordering vs the
  legacy "Daemon details" collapsible.
- **Design source of truth**: tokens in `frontend/src/app/globals.css` :root (Safe Linear
  System), primitives in `frontend/src/components/ui.tsx`. Reuse both; per-area css files
  (`courses-ui.css`, `sessions-ui.css`, `materials-ui.css`, `settings-ui.css`, `schedule-ui.css`) hold screen-specific styles.
- **Branch**: all of this lives on `ui-overhaul`.
- **Local QA rig**: `src/scripts`-less — fixtures were built at `/tmp/as-qa` (stub daemon on
  :7800 mirroring real payload shapes, `AUTO_SCHOOL_DATA` fixture tree). Not committed.

## Already shipped (do NOT re-implement)

KPI stat cards, deadline filter tabs with counts + text search, overdue rows with day badges,
checkbox/bulk selection, milestones "Worth Spreading Out" panel, mapping rail (11-active style),
registered-course grid, daemon/whisper status cards, week-grouped sessions with sprint labels,
playback-speed cycling + scrubber, re-transcribe + move-to, structured AI summary styling,
suggested prompts, token meter, collapsible source-docs panel above the chat thread,
file-explorer tree with category chips + large-file
emphasis, drop zone + semester-anchor toolbar + expand-all/select-visible, "Ask AI across N
materials" CTA, daemon status bar with pause/scan controls, completed-sessions list, automation
directives toggles, day/3-day calendar switcher, failover-chain editor + RAW_LIST, stepper
fields, masked API vault, quota monitor table + 429 explainer, config-state bar.

## Descoped on ui-overhaul (removed — do NOT re-add without a design decision)

- **Chat right rail** (Next Deliverable progress-ring + interactive checklist widget) and the
  **context strip** ("Context loaded" chips + model pill) above the thread. Rationale: single-column
  chat layout; deadline/checklist interaction remains on the Deadlines screen. Note: the stitch
  mockups (ANALYSIS.md screen 3) still show a 2-col chat with rail + context strip — the
  divergence is deliberate. The "Next Deliverable" API itself (/api/deadlines + /api/checklists)
  is unchanged.
- **Search pill** (⌘K launcher button), **cron chip**, **version pill** (header), **courses hero badge** —
  removed with the header/kbd palette deferral; none of these were wired beyond styling.