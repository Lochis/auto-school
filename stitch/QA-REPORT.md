# UI Overhaul — Visual QA Report

Captures: `/tmp/as-qa/shots/` (1440×1100 full-page, dev build, local QA daemon).
Spec: `stitch/ANALYSIS.md`. Mockups: `stitch/stitch_ui_modernization_project/*/screen.png`.

---

## Verdict per screen

### 1. courses.png ↔ courses_deadlines_manager — **PARTIAL**
- Chrome, hero (emerald dot, SYNCED chip, 3 action buttons), 4 stat cards, deadlines panel with filter tabs, right rail (Meeting→Course Mappings + Whisper Daemon Listener) and Registered Course Repositories grid are all present and close to the mockup.
- **Missing entire "Worth Spreading Out / Upcoming Milestones" section** (mockup: full-width panel with `7 items` chip, 2-column milestone cards, Study Plan/Checklist links). The list goes straight from deadline rows to the repositories panel.
- Deadline rows are ~2× taller than mockup: titles wrap to 2 lines, each row carries its own meta line and 5 icon buttons (edit/check/calendar/download) instead of the compact single-line row + `⋮` overflow of the mockup.
- Footer daemon bar absent; page tail is a large blank region. Hero badge reads `SYNCED // 12 ITEMS` (mockup `SYNCED // 48kHz` — copy drift).

### 2. sessions.png ↔ course_sessions_transcripts — **PARTIAL**
- Course shell (breadcrumb `← All Courses / 26F`, hero, `Sessions (6) | Materials | Ask` tabs, Ingest button, inline audio player, week-grouped cards, Class Notes / Transcript collapsed rows with AI Structured Summary eyebrow) matches the mockup's structure well.
- Breadcrumb strip right side shows plain `COURSE REPOSITORY` text instead of the mockup's segmented `Sessions | Materials | Ask` tab pill row; there is only one breadcrumb tier (mockup has a second `← All courses / TERM_26F`), and the hero lacks the `● SYNCED` pill and `26F-` title prefix.
- Session cards are much looser than mockup: `move to…` renders as a full-width native `<select>` on its own row, Delete/Play on a third row; mockup has `⟳ Re-transcribe | move to…▾ | Delete | ▶ Play recording` inline on one action bar.
- Collapsed transcript rows show segment counts only (`12 segments`) without the mockup's word counts (`12 segments · 1,480 words`). Footer absent.

### 3. sessions-session.png (no dedicated mockup; judged against mockup's expanded session card) — **PARTIAL**
- Breadcrumb (`← …Project 1 / 2026-10-06` + `SESSION RECORDING`), title, meta line, Timeline panel, and Class Notes with `OVERVIEW` + `KEY MILESTONES & ACTIONS` item cards (Jira Backlog Grooming, Database Schema Freeze) faithfully reproduce the mockup's expanded card.
- **Below the structured summary the panel dumps raw unstructured text**: plain heading `Class Notes — 26F - COMP231 - (SEC. 401) - Lab`, bold `Key Topics`, and `User Role Modeling [10:00] — definition vs personas, …` with no eyebrow styling — looks like unstyled markdown leaking out of the notes renderer, and the content ("User Role Modeling") belongs to the 2026-10-02 lab session, not this 10-06 kickoff.
- No word counts / segment detail on the transcript row; large blank page tail (no footer).

### 4. chat.png ↔ course_ai_assistant_knowledge_chat — **PARTIAL**
- Present and on-language: context strip (`Context loaded:` + doc chips + `clear` + `Model: gemini-3.8-flash`), Source Documents sidebar (`15 Indexed` with sizes + open icons), empty-state hint card with quoted suggested-prompt chips, composer with `Web off` + `tokens: 0 / 128k` + emerald Send.
- Right sidebar has **only Source Documents**; mockup's `Next Deliverable` (progress ring + checklist) and `Team Protocols` panels are absent — see data-gap section before chasing.
- Chat thread area is empty (no assistant/user bubbles, citations, red callout) — no local chat history; also `tokens: 0 / 128k`.
- Breadcrumb strip behind the hero renders as a blank rounded panel on this route; composer lacks the mockup's `Add file` chip. Footer absent.

### 5. materials.png ↔ course_materials_file_explorer — **CLOSE**
- Strongest screen: hero + tabs, 4 stat cards (`15 Files / 4 Folders`, `69.6 MB processed`, `● Ask Pipeline Ready`, `ACTIVE SEMESTER ANCHOR`), drop zone, semester-start toolbar with helper text + `Expand All / Select Visible`, hierarchical file tree (Week 1–3, nested `Project Proposal`, `LOOSE / ROOT RESOURCES`, checkboxes, colored category chips, cyan large-file sizes, per-row actions), sync strip, and `Ask AI across 15 Indexed Materials` CTA all match the mockup layout.
- Copy/format drift vs mockup: drop-zone chip `PDF / DOCX / MP4 / XLSX` (mockup `ZIP / PDF / DOCX / MP4`), `Add Folder` (mockup `New Folder`), parser card says `Ask Pipeline Ready` (mockup `Embeddings Ready`), sync strip shows `Sync daemon: Idle … last scan 48m ago` (mockup `watching folder /mnt/courses/26F-COMP231 … Last polled 2m ago` — daemon state, see data gaps).
- CATEGORY column uses colored file-type chips + `wk N` tags where the mockup uses plain category text (`week 1`, `proposal`, `root`). Mockup's `.index` hidden/system row not present (likely no cache dir locally). Footer absent.

### 6. schedule.png ↔ schedule_automation_dashboard — **PARTIAL**
- All five mockup regions exist: daemon status bar, Completed Sessions, Activity Stream, Automation Directives, Calendar panel; styling (pills, chips, log tags, emerald accents) tracks the mockup.
- **Calendar panel body is empty**: no timeline strip, no hour axis, no agenda days — just `✓ Graph live schedule` and `No scan data yet — hit Manual Scan, or wait for the next poll.` Title reads `Calendar — Wednesday 7 Oct` (see hydration section; mockup: `Wednesday, 7 Oct`).
- Daemon bar missing the `PID: 4902` chip; second directive toggle is `Live Transcribe & Summarize` instead of mockup's `Auto-Pull Daily Schedule` (LMS scan 06:00); Completed Sessions rows lack the 🕐 time icon and per-row open-folder button.
- Footer daemon bar renders *between* the Calendar panel and a legacy `▶ Daemon details — sessions, activity & next` collapsible instead of at the document end as in the mockup. Next.js dev-mode "N" badge floats at the left edge (capture artifact of the dev build).

### 7. settings.png ↔ settings_model_pipeline — **CLOSE**
- Hero (`PIPELINE CONTROL MATRIX / v2.4`, headline, right status trio: 7 Tiered / gemini-3.8-flash / Eager Backoff), Transcription panel (master toggle, 2×2 steppers 0/4/9/2 with unit chips), Dynamic Failover Sequence (numbered model pills with arrows + `RAW_LIST` well), API vault wells, and the Quota Monitor table (PRIMARY badge, Available pills, RPM/RPD `—`, last-dispatched, `1 cooling down` chip, 429 explainer callout) all closely match.
- API vault gaps: no `● set: settings***xxxx` status text beside key labels; GLM Base URL shows `use default` where mockup has a `Ping` test button; **OAuth Token Exchange / `Validated via Local Docker Keyring` / `SYNCED` card missing** (possibly env-gated — see data gaps).
- Quota table header missing mockup's `● All Healthy` + `⟳ Probe Quotas` actions; config-state bar (`Synchronized — no pending changes` + Purge/Save) is sandwiched between the vault and the quota table instead of the mockup's sticky bottom bar.
- Hero chip `/ v2.4` vs mockup `/ v2.4-stable` (minor). Footer absent.

### 8. ask-all.png (no mockup — consistency judgment) — **CONSISTENT**
- Navbar, `← Courses` breadcrumb, hero, context strip with `clear` + model chip, dashed empty-state card with quoted prompt chips, and bottom composer with `Web off` / `tokens: 0 / 128k` / Send all use the same design language as the course Ask tab.
- Same two chrome nits as elsewhere: composer missing `Add file` chip, no footer daemon bar on this route. No visible breakage.

---

## Defects (prioritized)

| SEVERITY | SCREEN | WHAT IS WRONG (observable in capture) | SUSPECTED FILE OR AREA |
|---|---|---|---|
| P1 | Schedule (root) | Calendar panel title rendered in en-GB format `Calendar — Wednesday 7 Oct` (mockup/client: `Wednesday, Oct 7` / `Wednesday, 7 Oct`) — confirmed SSR/client hydration mismatch; agenda day headers use the same pattern | `frontend/src/app/calendar-list.tsx:77` (also `:154-155`); render chain `page.tsx:9` → `calendar-board.tsx` → `components/schedule/schedule-screen.tsx:25` |
| P1 | Courses | "Worth Spreading Out / Upcoming Milestones" section entirely missing (mockup: full-width panel, `7 items` chip, 2 milestone cards, Study Plan/Checklist links) | courses page / `deadlines-panel.tsx` milestone section |
| P1 | All non-root routes (courses, sessions, session detail, chat, materials, settings, ask-all) | Footer daemon status bar (`AUTOSCHOOL DAEMON // ACTIVE … PIPELINE READY`) not rendered — page tails are blank. `BackendBar` is imported/rendered only in `page.tsx` (root), not in `layout.tsx` | `frontend/src/app/page.tsx:1,10`; `layout.tsx` (no BackendBar) |
| P1 | Session detail | Class Notes panel contains a raw unstructured text dump below the structured summary: plain `Class Notes — 26F - COMP231 - (SEC. 401) - Lab`, `Key Topics`, `User Role Modeling [10:00] — …`; no eyebrow styling; content belongs to a different session (10-02 lab) | course session notes/transcripts component (`frontend/src/app/course/`) |
| P1 | Chat | Breadcrumb strip behind hero renders as a blank rounded panel (no breadcrumb text) on the Ask route | course layout breadcrumb component |
| P2 | Courses | Deadline rows ~2× mockup height: wrapped 2-line titles, per-row meta line, 5 icon buttons per row vs mockup compact single-line rows with `⋮` overflow — density/vertical rhythm clearly off | `deadlines-panel.tsx` / `courses-ui.css` |
| P2 | Courses | Repo cards wrap to 2 lines, show extra `SESSIONS` buttons + red trash icons (mockup: single-line, edit pencil only); `attic` card lacks mockup's `Ingest Manual Audio File` button; hero badge copy `SYNCED // 12 ITEMS` vs `SYNCED // 48kHz` | courses repositories grid |
| P2 | Sessions / chat / ask-all | Session-card action bars not compact (`move to…` = full-width native select on its own row); transcript rows missing `· 1,480 words` counts; hero lacks `● SYNCED` pill, `26F-` title prefix, second breadcrumb tier; breadcrumb right side shows `COURSE REPOSITORY` text instead of segmented `Sessions\|Materials\|Ask` tabs; composer missing `Add file` chip | course layout + session card component + chat composer |
| P2 | Schedule | Daemon bar missing `PID: 4902` chip; Automation Directives second toggle is `Live Transcribe & Summarize` instead of mockup `Auto-Pull Daily Schedule`; Completed Sessions rows missing 🕐 time icon and per-row open-folder button; config footer sits mid-page above a legacy `▶ Daemon details` collapsible rather than at document end | `components/schedule/daemon-bar.tsx`, directives panel, completed-sessions panel, `backend-bar.tsx` |
| P2 | Settings | API vault missing `● set: settings***xxxx` status per key; GLM Base URL shows `use default` instead of `Ping`; OAuth Token Exchange card missing; quota table header missing `● All Healthy` + `⟳ Probe Quotas`; config-state bar placed between vault and quota table instead of sticky bottom | settings vault + quota monitor components (`frontend/src/app/settings/`) |
| P2 | Materials | Copy drift: `PDF / DOCX / MP4 / XLSX` vs mockup `ZIP / PDF / DOCX / MP4`; `Add Folder` vs `New Folder`; `Ask Pipeline Ready` vs `Embeddings Ready`; CATEGORY column uses colored file-type chips + `wk N` instead of plain category text (`week 1`/`proposal`/`root`) | materials table + drop-zone components (`materials-ui.css` area) |
| P2 | All captures | Next.js dev-mode badge ("N" circle) floating at left edge of every screenshot — dev build artifact; confirm production build hides it | Next.js dev overlay (not app code) |

**P0 note:** no fully broken layout, invisible text, or overlapping elements were observed in any capture. The worst visual defects are the missing panels/sections and the hydration-driven locale mismatch above.

---

## Data-gap false negatives

These look empty/thin in the captures but the mockups' versions depend on live daemon data the local QA environment does not have. **Do not chase them as design defects:**

1. **Schedule — Calendar body** (`schedule.png`): empty with `No scan data yet — hit Manual Scan…`. The timeline strip, hour axis, agenda day groups, `attended — persisted` / `not joined · queued` badges, Autopilot Target chip, and the `N sessions scheduled today · scanned …` subtitle all come from the server scan dump (`out/calendar-events.txt` via `readCalendar()`). Mockup shows them with a populated scan.
2. **Schedule — Activity Stream mini-stats** (`GEMINI TOKENS TODAY` / `STORAGE USED`): absent in capture; hidden when no token/storage telemetry exists locally. Only flag if they stay missing with a live daemon.
3. **Chat — thread + sidebar panels**: no assistant/user messages, citations, red callout, or `Next Deliverable` / `Team Protocols` panels; `tokens: 0 / 128k`. Requires local chat history and per-course deadline/team data.
4. **Sessions — recording telemetry**: `no recording` / `recording unplayable — transcript access still works` states, `Transcribe` ghost instead of `Play recording`, no speaker metadata in the audio player, no transcript word counts. Requires real `.webm` captures in the QA daemon's storage.
5. **Courses — counts**: `10 Open / 2 Done / 1 Overdue`, `This Week (7)`, `6 Active` mappings, most repo cards at `0 indexed sessions` — small local dataset, not layout gaps.
6. **Materials — daemon state**: `Sync daemon: Idle … last scan 48m ago` vs mockup's `watching folder /mnt/courses/26F-COMP231`; `ACTIVE SEMESTER ANCHOR not set` + empty semester date; `.index` hidden/system row absent (no local index cache).
7. **Settings — OAuth Token Exchange card** and `● set: settings***` key-status lines: likely env-gated (no Docker keyring / secrets in QA pod). Verify against a deployment with the keyring before filing.
8. **Settings — `Config state: Synchronized`**: live dirty-state indicator; mockup's `Unsaved modifications in staging` is just the mockup's unsaved-edit scenario.

---

## Hydration bug (root cause hunt)

**Symptom (confirmed in capture):** server HTML shows `Calendar — Wednesday 7 Oct` (day-before-month, no comma — en-GB-style default); client re-renders `Calendar — Wednesday, Oct 7` (en-US). Root route `/`.

**Render chain (verified by reading the files):**
1. `frontend/src/app/page.tsx:2` — imports `CalendarBoard`; `page.tsx:9` — renders `<CalendarBoard />` (root page also mounts `BackendBar` at `page.tsx:10`).
2. `frontend/src/app/calendar-board.tsx` — server component, `export const dynamic = "force-dynamic"`; reads the calendar scan and renders `<ScheduleScreen events={plain} asOf={…} />`.
3. `frontend/src/components/schedule/schedule-screen.tsx:12,25` — `"use client"` route that imports `CalendarList` from `../../app/calendar-list` and mounts it — so `CalendarList` **is** server-rendered on the initial HTML pass.
4. `frontend/src/app/calendar-list.tsx:37` — `const [now, setNow] = useState(() => new Date());` — a client-clock value that is nevertheless evaluated once on the server during SSR.
5. `frontend/src/app/calendar-list.tsx:77` — the defective line:
   ```ts
   title={`Calendar — ${now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}`}
   ```
6. Same pattern at `calendar-list.tsx:154-155` for agenda day headers (`Today — ${…toLocaleDateString([], …)}` / weekday labels) — these will mismatch identically. (`calendar-list.tsx:24` hardcodes `"en-US"` and is safe; `src/lib/calendar*.ts` does no locale formatting.)

**Mechanism:** two independent SSR/client divergence sources combine here:
1. **Locale-dependent default:** `toLocaleDateString([])` passes an **empty locales array**, so formatting falls back to each runtime's *default* locale. SSR runs in Node, whose default ICU locale comes from the server environment (here producing `en-GB`-style "7 Oct", no comma — exactly the string seen in `schedule.png`'s panel title, i.e. the capture caught the server HTML). The browser defaults to `navigator.language` (en-US → "Oct 7" with comma). Same date, different string → React hydration mismatch on the panel `<title>`.
2. **Server-clock vs client-clock:** `useState(() => new Date())` is evaluated during the SSR pass and again on the client; a non-midnight, non-second-aligned render (plus the 15 s `setInterval` refresh at `calendar-list.tsx:41`) can additionally differ in day boundary/minute content, amplifying the mismatch beyond formatting.

The mockup's format (`Calendar — Wednesday, 7 Oct`) matches neither capture string cleanly but is en-US-with-comma day-after-month — consistent with the intended client-side rendering; the capture's `Wednesday 7 Oct` is unambiguously the Node-default-locale server output.

**No fix applied — report only.** (For the record, the standard remedies would be: pass an explicit locale array, e.g. `toLocaleDateString("en-US", …)` consistent with `calendar-list.tsx:24`, and/or derive the title from a stable server-provided value instead of `now`.)
