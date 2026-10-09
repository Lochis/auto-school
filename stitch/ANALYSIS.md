# Stitch UI Modernization — Screenshot Analysis

Source: 6 screens under `stitch/stitch_ui_modernization_project/*/screen.png` + `safe_linear_system/DESIGN.md`.

---

## Design system summary

### Color tokens (CSS-variable style)

```css
:root {
  /* From DESIGN.md token dump */
  --surface:                 #12131a;  /* base canvas */
  --surface-dim:             #12131a;
  --surface-bright:          #383941;
  --surface-container-lowest:#0d0e15;  /* deepest wells (inputs, code pills) */
  --surface-container-low:   #1a1b22;
  --surface-container:       #1e1f26;  /* cards/panels */
  --surface-container-high:  #292931;  /* nested rows, hovers */
  --surface-container-highest:#33343c; /* active/selected wells */
  --surface-variant:         #33343c;
  --on-surface:              #e3e1ec;  /* primary text */
  --on-surface-variant:      #bbcabf;  /* secondary text */
  --inverse-surface:         #e3e1ec;
  --inverse-on-surface:      #2f3038;
  --outline:                 #86948a;  /* muted borders/text */
  --outline-variant:         #3c4a42;  /* hairline borders */

  --primary:                 #4edea3;  /* emerald — success, live, active */
  --on-primary:              #003824;
  --primary-container:       #10b981;  /* solid emerald buttons */
  --primary-fixed:           #6ffbbe;

  --secondary:               #c0c1ff;  /* indigo — AI, links, active tabs */
  --secondary-container:     #3131c0;
  --on-secondary-container:  #b0b2ff;

  --tertiary:                #4cd7f6;  /* cyan — telemetry, sync alerts */
  --tertiary-container:      #00b2d0;
  --on-tertiary-container:   #003f4b;

  --error:                   #ffb4ab;  /* overdue / destructive */
  --error-container:         #93000a;
  --on-error:                #690005;

  /* Documented (per Brand & Style prose) */
  --canvas-base:             #09090b;
  --panel-surface:           #18181b;
  --component-surface:       #27272a;  /* inputs, ghost buttons */
  --line:                    #27272a;
  --line-hover:              #3f3f46;
  --text-hi:                 #fafafa;
  --text-mid:                #a1a1aa;
  --text-low:                #71717a;

  /* Runtime badge palettes observed in screenshots */
  --badge-emerald:  bg emerald-950/40 + text #4edea3 + border emerald-800/50;
  --badge-indigo:   bg indigo-950/40 + text #c0c1ff + border indigo-800/50;
  --badge-cyan:     bg cyan-950/40 + text #4cd7f6 + border cyan-800/50;
  --badge-red:      bg red-950/30 + text #ffb4ab + border red-800/40;
  --badge-neutral:  bg #27272a + text #a1a1aa + border #3f3f46;

  /* Elevation */
  --shadow-modal:   0 8px 24px -4px rgba(0,0,0,0.6);
  --glow-active:    0 0 12px rgba(16,185,129,0.25);  /* live/recording halo */

  /* Radii */
  --radius-sm:   0.125rem;  /* 2px  — badges, code pills */
  --radius:      0.25rem;   /* 4px  — buttons, inputs, tags */
  --radius-md:   0.375rem;  /* 6px */
  --radius-lg:   0.5rem;    /* 8px  — cards, panels */
  --radius-xl:   0.75rem;   /* 12px */
  --radius-full: 9999px;    /* pills, ping dots */

  /* Typography — Inter everywhere; tabular nums on all data */
  --font: 'Inter', sans-serif;
  --headline-lg: 600 1.75rem/2.25rem Inter, -0.02em;
  --headline-md: 600 1.25rem/1.75rem Inter, -0.015em;
  --headline-sm: 600 1rem/1.5rem Inter, -0.01em;
  --body-lg:     400 0.9375rem/1.5rem Inter;
  --body-md:     400 0.875rem/1.25rem Inter;
  --body-sm:     400 0.8125rem/1.125rem Inter;
  --label-md:    500 0.8125rem/1rem Inter;
  --label-sm:    600 0.6875rem/0.875rem Inter;   /* uppercase micro-labels */
  --code-tab:    500 0.75rem/1rem Inter;         /* code/monospace-parity */

  /* Spacing */
  --space-xs: 0.25rem; --space-sm: 0.5rem; --space-md: 0.75rem;
  --space-lg: 1.25rem; --space-xl: 2rem;
  --gutter: 1rem;      --gutter-desktop: 1.5rem;
  --margin: 1rem;      --margin-desktop: 2rem;

  /* Layout */
  --container-max: 1280px;   /* 1440px for wide consoles */
  --header-h: 48px;
  --btn-h: 32px;             /* inputs/buttons 32–36px */
  --micro-h: 24px;           /* "Ask AI", "+ Checklist", chip actions */
}
```

### Observed patterns across all 6 screens

- **Chrome is identical everywhere:** top 48px command header (logo + `CRON: IDLE` chip left; centered pill nav `Schedule | Courses & Deadlines | Settings`; right: `Quick filter… ⌘K` search pill, `v2.4 ▲ 99.8%` status pill, circular emerald avatar button) and a footer status bar: `AUTOSCHOOL DAEMON // ACTIVE · © 2025 AutoSchool Engine` left, `LISTENER: STEREO 48kHz · PIPELINE READY` right (pipeline-ready text in emerald).
- **Two nav tiers on course screens:** header nav + a breadcrumb strip (`← All Courses / 26F-COMP231 Software Development Project 1`) with right-aligned segmented `Sessions | Materials | Ask` tabs; the active tab is an emerald-filled pill with dark text; on Materials the tab shows a count (`Materials 16`), on Sessions `Sessions (8)`.
- **Panels:** `--surface-container` fill, 1px `--outline-variant`/`#27272a` hairline border, 8px radius, no diffuse shadow (shadows only on floating/overlays).
- **Micro-labels:** uppercase `label-sm` in `--outline`/`#71717a` above bold larger values (stat cards, column headers, section eyebrows).
- **Data numerals:** tabular-nums on dates, times, sizes, counts, weights, segment counts.
- **Accent discipline:** emerald = active/live/success/primary CTA; indigo = AI/links/active filter tabs; cyan = telemetry/sync/system tags; red = overdue/destructive; neutral = everything else.
- **Iconography:** small monochrome/duotone glyphs (20px) often inside a 28px rounded tinted square (emerald-tinted, cyan-tinted, indigo-tinted) beside headings and stat cards.
- **Buttons:** solid emerald primary (dark text), neutral ghost (`#27272a` + `#3f3f46` border), and 24px micro-actions with inline glyphs ("Ask AI", "+Checklist", "Note", "Study Plan"). Destructive = red-outlined.
- **Chips/badges:** rounded-sm rectangular course-code tags on `#27272a`, rounded-full status pills (synced/live/done/archived/queued), emerald pulsing dot for live states.

---

## Per-screen breakdown

### 1. courses_deadlines_manager/screen.png

**Layout:** header → full-width hero panel → 4-column stat row → two-column body (main ~2/3 left "Scheduled Course Deadlines" + right rail ~1/3) → full-width "Registered Course Repositories" panel → footer.

**Header:** autoschool logo (emerald dot glyph + wordmark with `school` in emerald); `• CRON: IDLE` neutral chip; centered tabs: `Schedule`, `Courses & Deadlines` (active — filled neutral `#27272a` pill), `Settings`; right: `Quick filter… ⌘K` pill with sliders icon, `v2.4 ▲ 99.8%` pill, emerald circular avatar button.

**Hero panel:** emerald dot + `Courses & Academic Deadlines` (headline-lg); badge `SYNCED // 48kHz` (neutral bordered chip); subtitle "Automated course folder mappings, transcript extractions, and deadline tracking daemon."; right-aligned buttons: `⟳ Update Deadlines` (ghost), `⟳ Full Rebuild` (ghost), `🎓 Ask AI for All Courses` (emerald primary).

**Stat cards (4):**
1. `TOTAL ACTIVE QUEUE` — `108 Open` — emerald check-circle icon tile.
2. `COMPLETED WORK` — `37 Done` (emerald text) — emerald list-checks tile.
3. `REQUIRES ATTENTION` — `1 Overdue` (red text) — red alert-triangle tile.
4. `REGISTERED FOLDERS` — `7 Directories` (indigo text) — indigo folder tile.

**Main panel — "Scheduled Course Deadlines":** calendar icon + heading; right: search input `Filter assignments, tests…` (magnifier). Filter tab row: `This Week (26)` (active indigo-filled pill), `Later (79)`, `Done (37)`.
- **Overdue item** (red-tinted row): checkbox, `OVERDUE (3D)` red badge, `COMP309` code chip, title "Practice: Accuracy/Precision/Recall activities", meta "Due: 2026-10-04 • Week 4 summary activities; exam-style tumour model questions"; right micro-actions `🎓 Ask AI`, `✓ Checklist`, `≡` overflow.
- **"IMMEDIATE DELIVERABLES"** micro-label, right `OCT 07 — OCT 14`; collapsible rows each with checkbox, title, course chip, due badge, and per-row actions:
  - Assignment 1: Spring Boot MVC Car Insurance Quotation — `COMP303`, `Due Tomorrow (Oct 8)` — "Progress: **0/11 tasks** •", desc "10%; scheme announcement Oct 8; 5-8 min video demo required"; actions Ask AI, +Checklist, Note, collapse chevron.
  - Lab 2: AWS DynamoDB Key-Value Model — `COMP306`, `Oct 09 (In 2d)` — "Weight: 10% • C# app for DynamoDB; Friday at midnight deadline"; Ask AI, +Checklist, ⋮.
  - Quiz #4: Module 4 Architectural Drivers — `COMP255`, `Oct 11 (In 4d)` — "1%; top 10 of 11 quizzes count towards grade"; Ask AI, Note, ⋮.
  - Discussion Threads Q1-Q4 (Mobile Life-Cycle & Strategy) — `COMP255`, `Oct 11 (In 4d)` — "Module 4 discussion forum • Due Week 5 per evaluation schedule"; Ask AI, +Checklist, ⋮.
  - Read Chapter 4 – Mitigating Internet Risks — `COMP307`, `Oct 11 (In 4d)` — "Harwood, Internet Security Ch.4; Week 5 checklist reading notes"; Ask AI, ⋮.
  - Exercise 5: Power BI Reporting Integration — `COMP309`, `Oct 11 (In 4d)` — "Restore WideWorldImportersDW-Full.bacpac; build report for lab presentation"; Ask AI, +Checklist, ⋮.
- **"Worth Spreading Out / Upcoming Milestones"** header with `7 items` chip and `Collapse ∧`; 2-column grid of milestone cards:
  - `COMP306` + `Start: 2026-10-12` (indigo) — "Test 1 (Weeks 1-6 Materials)" — "Weight: 25%; open book; scheduled during lab; confirm with prof." — footer: `High Impact` chip + `🎓 Study Plan` link.
  - `COMP309` + `Start: 2026-09-28` — "Group Project #1 – Kickoff" — "Begin per Week 4 checklist; group presentations expected Week 6 (Oct 12-18)." — footer: `Milestone` chip + `⇄ Checklist` link.

**Right rail:**
- **"Meeting to Course Mappings"** panel — funnel icon; `11 Active` neutral chip; description "Exact title match files a session under the folder you choose. Overrides auto parsing."; form: input `Meeting Name Pattern` placeholder "e.g. 26F - COMP231 - Lecture"; select `Target Directory Folder` "Select existing or type novel…"; full-width cyan primary button `🔗 Link Match Rule`. Below: 6 mapping rows, each: source-title line + indigo `→ folder-name` link + `✕` remove: "26F - COMP3231 (SEC. 401) - Lecture → 26F-COMP231-Software_Development_Project_1", "26F - COMP231 - (SEC. 401) - Lab → …Project_1", "26F -- Data Warehs & Predictv Antlcs (SEC. 4… → 26F-COMP309-Data_Warehs_Predictv_Antlcs", "COMP303-Lesson 1.1 → 26F-COMP303-Enterprise_App_Dev", "Module 1: Understanding Entrepreneurship → 26F-COMP255-Business_and_Entrepreneurship", "26F -- Software Security (SEC. 402) → 26F-COMP307-Software_Security".
- **"Whisper Daemon Listener"** compact card — mic icon; "Auto-extracting tasks from 48kHz audio strea…" (truncated); emerald live dot on the right.

**Bottom panel — "Registered Course Repositories":** code icon; right: input "e.g. COMP308 – Systems Progra…", input "Semester starts: YYYY-M…", emerald `＋ Register Course` button. 3×2 grid of course repo cards, each: tinted icon tile (monitor, briefcase, grid, cloud, shield, database), code+name, "N Indexed sessions", pencil edit button:
- COMP3231: Software Dev Project — 8; COMP255: Business & Entrepreneurship — 4; COMP303: Enterprise App Dev — 7; COMP306: API & Cloud Computing — 10; COMP307: Software Security — 8; COMP309: Data Warehousing — 10.
- Last row: `attic (unassigned ingress recordings)` with `0 sessions pending` chip, right button `Ingest Manual Audio File`.

---

### 2. course_sessions_transcripts/screen.png

**Layout:** header → breadcrumb strip + `Sessions | Materials | Ask` tabs (Sessions active) → second breadcrumb `← All courses / TERM_26F` → course hero → inline audio player → week-grouped session cards → footer.

**Hero:** `26F-COMP231-Software Development Project 1` headline-lg with `#` hash badge; `● SYNCED` emerald pill; sub-tab row `Sessions (8)` (emerald active pill), `Materials`, `Ask`; right: emerald `⊕ Ingest a Teams recording ›` button.

**Inline audio player (panel):** emerald play button tile; title "Lecture: User Stories & Sprint 1 Kickoff" + `2026-09-29` date chip; "Speaker: Prof. Aris Thorne · Stereo 48kHz · Lossless Opus"; time `18:42` … emerald progress bar with round scrubber … `48:15`; controls right: `1.25x` speed pill, speaker/volume button, subtitle/captions button.

**Week 5 group:** `• Week 5` + `1 session` chip; right micro-label `CURRENT SPRINT`.
- Session card (expanded): header `2026-10-06 · 9:27 AM` + external-link icon; status `● recorded · transcribed · 12 segments merged` (link-style indigo); right actions: `⟳ Re-transcribe`, `move to… ▾` (ghost select), `🗑 Delete`, emerald `▶ Play recording`.
  - Collapsible "Class Notes — 26F - COMP231 - (SEC. 401) - Lab" expanded with eyebrow `AI Structured Summary` right; sections `OVERVIEW` (kickoff sync text, inline `feature/*` vs `hotfix/*` code chips) and `KEY MILESTONES & ACTIONS` — 2 side-by-side item cards with icon: `✓ Jira Backlog Grooming — Re-estimate complexity points with story poker format.` and `⛓ Database Schema Freeze — Prisma migration schemas locked by Friday 11:59 PM.`
  - Collapsed footer row: `▸ Transcript (Merged Stems)` + right "12 segments · 1,480 words".

**Week 4 group:** `• Week 4` + `2 sessions`; right `ARCHIVED · 2 RECORDINGS`. 2-column grid of session cards (not expanded as player, but similar action bars):
- Left: `2026-10-02 · 8:59 AM`, `● recorded · transcribed · 6 segments merged`, actions Re-transcribe / move to… / Delete / Play; Class Notes expanded: OVERVIEW (user-role-modeling workshop, Cohn textbook) + KEY TOPICS: "User Role Modeling — Conceptual Understanding [10:00]" (indigo heading + tabular timestamp) with bullet definition/roles-vs-personas/framework stages.
- Right: `2026-09-29 · 10:33 AM`, `25 segments merged`, same action bar; Class Notes: OVERVIEW (Week 4 agile user-stories lecture) + KEY TOPICS "Intro & Logistics [5:00–10:00]" with bullets (module open, agenda, weighting 10%).

**Footer** identical to all screens.

---

### 3. course_ai_assistant_knowledge_chat/screen.png

**Layout:** header → breadcrumb + `Sessions | Materials | Ask` tabs (Ask active, emerald) → second breadcrumb with `26F-COMP231` code chip → course hero with edit pencil, `● SYNCED: EVAL_SCHEME.PDF (v2.4)` pill, right segmented `Sessions 8 | Materials | Ask` (Ask active emerald) → 2-column body: chat thread (~2/3) + right sidebar (~1/3) → composer → footer.

**Context strip (above chat):** `◉ Context loaded:` bold + chips `Evaluation Scheme.pdf` · `Lecture Transcripts (Sept 8, 11, 15)`; right indigo text `Model: Claude 3.5 Sonnet`.

**Chat thread:**
- `🤖 assistant 11:42 AM`: message with indigo `›`-prefixed list (Sept 20 Cohn reading, Sept 27 User Role Modelling — TAC report addition + workshop video, then cadence User Stories Oct 18 / Release Plan Oct 25 / Iteration Planning Nov 1), paragraph about Ticketranza proposal; two ghost chips: `📄 Draft TAC Sections`, `⚑ Review Ticketranza Objectives`.
- `you 11:45 AM` (right-aligned): **indigo solid bubble** with white text: "What are the "Workshop meetings" are they supposed to be the weekly scheduled meetings or are they for the graded piece for submissions. Are our weekly scheduled meetings to be recorded?"
- `🤖 assistant 11:46 AM`: rich answer — bold/italic emphasis, inline source citation chip `📄 Evaluation Scheme.pdf 👁 (pp. 1–2)`; heading `🎬 The two meanings of "workshop"`; two numbered sections each with badge (`Deliverable` green chip; `Operational Cadence` neutral chip): (1) Graded video workshops — bullets User Role Modelling (Week 3/4), User Stories (Week 6), Iteration Planning 1&2 (Weeks 8 and 10–11), one-off 5-min test bed demo (Week 12), Release demo video (Week 13); an info callout box "ℹ Rules for these: all team members must be present…" ; (2) Weekly workshop meetings — bullets lab slot Friday breakouts, independent team meeting; italic concluding line.
- **Red answer callout:** red-tinted bar with dot: "So, do we record our weekly meetings? — Yes" + right dark button `Add to Team Policy`.
- **Suggested-prompt chips row:** `"Show template for meeting minutes"`, `"Who is assigned as Agile Customer?"`, `"Generate Zoom recording checklist"` (quoted, bordered pills).

**Composer:** rounded input well "🖥 ask about this course…" with `✕` clear; footer row: `⊕ Web off` chip, `📎 Add file` chip, monospace `tokens: 2,410 / 128k` counter; right emerald `Send ↑` button.

**Right sidebar:**
- **"Source Documents"** panel — `3 Indexed` chip; 3 rows, each with file-type icon, name, meta, external-link icon: `Evaluation Scheme.pdf (pp. 1–6 · Updated Sept 12)`, `Cohn - User Stories.pdf (Ch. 3 (pp. 31–41))`, `Lecture Transcripts 01-03 (Stereo 48kHz auto-sync)`.
- **"Next Deliverable"** panel — `In 4 Days` green chip; **circular progress ring 65%** (emerald arc) beside "User Role Modelling / Due Sept 27 @ 23:59 / TAC Addition + Workshop Video" (indigo subtitle); **checklist**: ☑ Ticketranza Business Objectives Drafted, ☑ Tech-Stack Finalized, ☐ 3 TAC Sections Drafted, ☐ Record Graded Video (All members on-cam) — completed items get emerald checkboxes and strikethrough.
- **"Team Protocols"** panel — `Ticketranza` indigo chip; paragraph about 5 team members / availability slots / workshop transcripts; bottom row `● Meeting #4: Scheduled Friday 14:00 (Breakout)`.

---

### 4. course_materials_file_explorer/screen.png

**Layout:** header → breadcrumb + tabs (Materials active emerald with count) → second breadcrumb → hero with `#` + `● SYNCED` → 4 stat cards → drop-zone + toolbar → semester-date toolbar → large data-table file tree → sync-daemon status strip → "Ask AI" CTA panel → footer.

**Hero:** same course title; tabs `Sessions 8 | Materials 16 | Ask`.

**Stat cards (4):**
1. `TOTAL ARTIFACTS` — `16 Files` + " / 4 Folders" — file-box icon tile.
2. `INDEXED FOOTPRINT` — `68.4 MB processed` — database icon tile.
3. `SEMANTIC PARSER` — `● Embeddings Ready` (emerald) — sparkles/network icon tile.
4. `ACTIVE SEMESTER ANCHOR` — `Aug 9, 2026` — calendar icon tile.

**Drop zone:** cloud-upload icon tile; bold "Drop files or folders here" + " — or browse your machine"; sub "Auto-extracts slides, PDFs, code blueprints & syncs with Ask AI"; right: format chip `ZIP / PDF / DOCX / MP4`, emerald `⬆ Upload` button, ghost `＋ New Folder` button.

**Semester toolbar:** `📅 Semester starts:` + date input `08/09/2026` + calendar icon; `Save` ghost button; helper "— calculates dynamic week offsets & associates session recordings"; right: `↕ Expand All`, `☑ Select Visible` ghost actions.

**File table:** header row with master checkbox and columns `NAME & HIERARCHY | CATEGORY | SIZE | ACTIONS` (right-aligned). Tree rows with expand chevrons, folder/file icons, indent levels, per-row checkboxes, category tag, size (large files in cyan), action glyphs (download, tag/link, ✕ delete):
- `.index` — "hidden / cache" — category `System` — collapsed.
- `Week 1` — `6 items` chip — expand-all download glyph on folder row. Children: introduction.pdf (week 1, 245 KB); Samsung Printer Project (Google Drive API architecture v2).pdf (101 KB); TAC Technical Report Template.docx (1.3 MB); **User Role Modeling.mp4 (57.2 MB, cyan size)**; week 1 - overview .pdf (183 KB); week 1 - summary.pdf (177 KB).
- `Week 2` — `1 nested folder · 5 items` — child `▸ Project Proposal` (5 docs, "5 files" right); grandchildren: Project Charter & Scope Statement.docx (proposal, 412 KB), Stakeholder Matrix & Approvals.pdf (proposal, 188 KB).
- `Week 3` — `4 items`: "User Stories Applied_ For Agile Software Development (The -- Cohn_ Mike -- Signature_ March 1_ 2004 -- Addison-Wesl…" (week 3, 4.2 MB cyan), Week 3_ Overview.pdf (723 KB), Week 3_ Summary.pdf (519 KB), Writing and Gathering User Stories.pdf (453 KB).
- `LOOSE / ROOT RESOURCES` micro-header: Evaluation Scheme.pdf (root, 100 KB); Grading Sheet COMP231.xlsx (root, 48 KB).

**Sync strip:** `● Sync daemon: watching folder /mnt/courses/26F-COMP231` (emerald path); right: "Auto-indexing enabled · Last polled 2m ago".

**CTA panel:** robot icon tile; "Ask AI across 16 Indexed Materials" bold; sub "Query project charters, user stories, PDF lecture slides, and transcripts with citations."; right emerald `💬 Launch Ask AI` button.

---

### 5. schedule_automation_dashboard/screen.png

**Layout:** header (Schedule tab active) → daemon status bar → 2-column row (Completed Sessions left, Activity Stream right) → Automation Directives panel → full-width Calendar panel (timeline + 3-day list) → footer.

**Daemon status bar:** `● DAEMON IDLE` emerald pill + `PID: 4902` chip; center `SCHEDULED SESSION NEXT` micro-label, `Thu, Oct 8 : 10:28 AM` cyan, title "26F — Data Warehs & Predictv Antlcs (SEC. 402)"; right: "⟳ Last scan: 7:06:14 PM", ghost `⏸ Pause Joining`, ghost `⟳ Reset Scan`, emerald `◉ Manual Scan`.

**"Completed Sessions" panel:** gear icon; "6 captures consolidated and indexed to storage"; right emerald link "1.24 GB Total Captured". 6 rows, each: emerald check-circle, title, optional `SEC. 402` chip + `seg N` indigo chip, time `🕐 12:07 PM · 261 MB .webm`, status badge right (`Done` emerald pill / `Archived` neutral pill), folder icon button. Rows:
1. 26F — API Engineering & Cloud Comp — seg 18 — 12:07 PM · 261 MB .webm — Done.
2. 26F — Data Warehs & Predictv Antlcs — seg 22 — 2:22 PM · 237 MB .webm — Done.
3. Module 5 & 6: Testing & Validating Solutions — seg 14 — 9:44 AM · 234 MB .webm — Done.
4. COMP303 — Lesson 4 — seg 23 — "raw stream kept" note — 12:24 PM · 385 MB "(consolidate fallback)" — **Archived**.
5. Module 3 & 4: Market Analysis — seg 9 — 10:06 AM · 129 MB .webm — Done.
6. 26F — Software Security SEC 402 — seg 12 "deduped" — 7:03 PM · "Consolidated via hash" — Done.

**"Activity Stream" panel:** terminal icon; "Daemon event log & Gemini pipeline"; right `● LIVE` emerald. Dark inner well log, monospace-ish, bracketed source tags colored indigo/cyan/emerald:
- `07:10:02 [deadlines]` folded "AI Part B: Lean Canvas" into "Assignment 1: Entrepreneurial Process" → green "1 rule step applied"
- `07:06:14 [schedule]` built 11 events via browser automation
- `07:06:00 [schedule]` cron built: 0 change(s) found
- `12:07:44 [mux]` consolidated **226 MB** of segments → 261 MB webm (stream copy) (emerald number)
- `12:07:18 [mux]` joining 18 segment(s) audio/video tracks
- `12:07:02 [ai-notes]` lecture summary written to local vault
- `12:06:33 [ai-notes]` running summary updated (1,656 words)
- `12:05:51 [gemini]` processed segments [16,17]: chips `746 words`, `15 visual notes`
- Below log: 2 mini-stats `GEMINI TOKENS TODAY 42,810` | `STORAGE USED 18.4%` (emerald value).

**"Automation Directives" panel:** sliders icon; "Configure daemon polling triggers and automated meeting attendance". 2 toggle rows (emerald pill toggles, ON):
- `Auto-Pull Daily Schedule` — "Scans LMS at 06:00 and on manual trigger" — toggle on.
- `Auto-Join & Record Next Call` — "Inject audio tap 60s before start timestamp" — toggle on.

**"Calendar — Wednesday, 7 Oct" panel:** calendar icon; "2 sessions scheduled today · scanned 7:06 PM"; right view switcher: `Day View` (active neutral pill) | `3-Day Range`.
- **Timeline strip:** hour axis 06:00 AM → 09:00 PM; event blocks: teal `COMP303` block (~8:30–10:20) and indigo `26F-API` block; thin red current-time indicator line at 7:06 PM with marker; legend: `■ Past attended classes` (teal) and `■ Current time indicator (7:06 PM)` (red).
- **Agenda list, grouped by day:**
  - `TODAY — WEDNESDAY 7 OCT` + "2 sessions completed": ✓ 8:30 AM – 10:20 AM · COMP303-Lesson 5.1 "(in-person / not online)" · right emerald-outlined badge `⟳ attended — persisted`; ✓ 10:30 AM – 12:20 PM · 26F — API Engineering & Cloud Comp `SEC. 402` "(not online)" · `attended — persisted`.
  - `THURSDAY 8 OCT` + "3 upcoming classes": 1 8:30–10:20 · 26F — API Engineering & Cloud Comp SEC. 402 · `attended — persisted`; **2** 10:30 AM – 12:30 PM · 26F — Data Warehs & Predictv Antlcs SEC. 402 + emerald `Autopilot Target` chip + emerald dot marker · right `not joined · queued` badge (row highlighted); 3 1:30–3:30 PM · 26F — Software Security SEC. 402 · `not joined`.
  - `FRIDAY 9 OCT` + "2 lab & lecture sessions": 1 8:30–10:30 · 26F - COMP231 SEC. 401 + cyan `Lab Session` chip · `not joined`; 2 10:30–12:20 · COMP303 — Lesson 5.2 · `not joined`.

---

### 6. settings_model_pipeline/screen.png

**Layout:** header (Settings active) → hero panel with status trio → 2-column config row (Transcription & Processing left, API Credentials & Vault right) → full-width Model Fallback Chain & Quota Monitor table → sticky action bar → footer.

**Hero:** `● PIPELINE CONTROL MATRIX` emerald micro-label + `/ v2.4-stable` chip; headline "Settings & Automation Engine"; sub "Configure real-time audio transcription sequences, dynamic quota failover chains, API credentials, and autonomous cron recording lifecycles."; right bordered trio: `ACTIVE FALLBACK 7 Tiered`, `CURRENT DAEMON gemini-3.8-flash`, `FAILOVER POLICY Eager Backoff` (emerald values), separated by dividers.

**Left panel "Transcription & Processing":** mic icon; right code-style label `ENGINE_CONFIG`.
- Toggle card: "Transcribe & Summarize (Gemini)" bold + **emerald toggle ON**; description "When triggered, audio segments are transcribed and synopsized as classrooms conclude. Auto-fails over on HTTP 429 quota exhaustion."
- 2×2 stepper fields (label, unit chip, description, −/value/+ control):
  1. `Retention Policy` / `0 = forever` / "Keep raw video archives" — `DAYS` — value 0.
  2. `Live Batch Size` / `PER_REQ` (cyan) / "Live segments per batch" — `SEGMENTS` — value 4.
  3. `Manual Batch Size` / `RE-PROCESS` / "Audio chunks for course repass" — `CHUNKS` — value 9.
  4. `Early Join Lead` / `CRON_LEAD` / "Pre-flight connection buffer" — `MINUTES` — value 2.
- **"Dynamic Failover Sequence"** + `?` icon; right hint "Drag or shift priority". Numbered draggable pills chained with `→`: 1 gemini-3.8-flash ⚡(active, emerald) → 2 gemini-3.7-flash → 3 gemini-3.6-flash → 4 gemini-3.5-flash → 5 gemini-3.1-flash-lite → 6 gemini-2.5-flash → 7 gemini-2.5-pro. Below: `RAW_LIST` well listing all model ids comma-separated.

**Right panel "API Credentials & Vault":** link icon; right `PERSISTENT_VOL` label; description "Secrets are encrypted at rest on the local cluster volume. Overrides apply immediately without container restarts. Secret keys are never revealed in plaintext."
- `Gemini API Key` — `● set: settings***2NRw` (emerald) — masked password well + `Set` ghost button + `use env` neutral tag button.
- `GLM API Key` — `● set: settings***6lAr` — masked well + Set + `use env`.
- `GLM Base URL Endpoint` / `PROXY_TARGET` — link icon well `https://open.bigmodel.cn/api/coding/paas/v4` + `Ping` ghost button.
- Bottom card: `🛡 OAuth Token Exchange` — "Validated via Local Docker Keyring" — right `SYNCED` emerald pill.

**"Model Fallback Chain & Quota Monitor" table:** sparkles icon; right `● All Healthy` (emerald) + `⟳ Probe Quotas` link. Columns: `MODEL IDENTIFIER | ENGINE STATUS | RPM THRESHOLD | DAILY RPD LIMIT | LAST DISPATCHED | ACTIONS`. Rows (all `● Available` emerald pills; RPM/RPD show `—`):
- gemini-3.8-flash + `PRIMARY` emerald badge — Just now (Active).
- gemini-3.7-flash — 12m ago.
- gemini-3.6-flash, gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-2.5-flash, gemini-2.5-pro — `—`.
- Info callout below: "ℹ Quota limits show "—" until an initial HTTP 429 Too Many Requests response payload reveals the upstream quota tier. Gemini does not expose proactive quota headers on successful requests. Backoff initiates instantly to the subsequent tier, auto-cooling until midnight Pacific Time for daily limits."

**Sticky action bar:** `● Config state: Unsaved modifications in staging` (left); right: red-outlined `🗑 Purge Raw Segments`, emerald `💾 Save Changes`.

---

## Functionality inventory

Legend: **N** = looks like new functionality vs current app; **R** = restyle of something common that exists.

| # | Feature | Screen(s) | Verdict |
|---|---------|-----------|---------|
| 1 | Global command navbar with logo, CRON status pill, 3-tab nav, ⌘K quick-filter pill, version/quota pill, avatar | all | R (navbar exists; pill/status treatment new) |
| 2 | ⌘K global quick-filter/search | all | **N** |
| 3 | Version + accuracy/quota status pill (`v2.4 ▲ 99.8%`) in navbar | all | **N** |
| 4 | Footer daemon status bar (listener stereo 48kHz / pipeline ready) | all | R (backend-bar restyle) |
| 5 | Hero page header with SYNCED badge + action buttons (Update Deadlines, Full Rebuild, Ask AI for All Courses) | 1 | R (existing actions, new presentation) |
| 6 | 4 KPI stat cards (open/done/overdue/folders) | 1 | **N** (dashboard-style summary) |
| 7 | Deadline list with filter tabs (This Week / Later / Done with counts) | 1 | **N** (counts+filtering; deadlines panel exists but without filters) |
| 8 | Per-item text search within deadlines ("Filter assignments, tests…") | 1 | **N** |
| 9 | Checkbox selection on deadline rows | 1 | **N** (implies bulk actions) |
| 10 | Overdue red-tinted item with `OVERDUE (3D)` badge | 1 | **N** (deadline urgency surfacing) |
| 11 | Per-item "Ask AI" quick action | 1 | **N** (per-item AI, vs course-level chat) |
| 12 | Per-item "+Checklist" / "Note" micro-actions | 1 | **N** |
| 13 | Inline progress tracking ("Progress: 0/11 tasks") on deadline items | 1 | **N** |
| 14 | Collapsible "IMMEDIATE DELIVERABLES" date-window section | 1 | **N** |
| 15 | "Worth Spreading Out / Upcoming Milestones" cards with weight/impact, Study Plan, Checklist links | 1 | **N** |
| 16 | Meeting→Course mapping manager (pattern rule builder, target folder select, Link Match Rule, active rule list with remove) | 1 | **N** (mapping-manager exists as component; the rule-builder UX with 11-active list + override copy is expanded/new presentation — partial N) |
| 17 | Whisper Daemon Listener live status card | 1 | **N** (visible daemon telemetry) |
| 18 | Registered Course Repositories grid w/ indexed-session counts + edit | 1 | **N** (course registration/count dashboard) |
| 19 | Register Course inline form (code + semester-start inputs) | 1 | R (course-new exists) |
| 20 | "attic" unassigned-ingress bucket + "Ingest Manual Audio File" | 1 | **N** |
| 21 | Breadcrumb + segmented Sessions/Materials/Ask tabs with counts | 2,3,4 | **N** (tab-with-counts pattern; tabs exist but this is a new chrome) |
| 22 | Course hero with code hash badge, SYNCED pill, "Ingest a Teams recording" CTA | 2 | R (ingest exists) + new chrome |
| 23 | Inline audio player: scrubber, elapsed/total, 1.25x speed, volume, captions | 2 | **N** (speed/captions controls; audio playback exists → partial R) |
| 24 | Week-grouped session timeline ("Week 5 · CURRENT SPRINT" / "Week 4 · ARCHIVED") | 2 | **N** (sprint/archived grouping) |
| 25 | Session card status chips: recorded / transcribed / "N segments merged" | 2 | **N** (pipeline telemetry per session) |
| 26 | Session actions: Re-transcribe, move to…, Delete, Play recording | 2 | **N** (re-transcribe, move-to) |
| 27 | AI Structured Summary notes (OVERVIEW + KEY MILESTONES & ACTIONS with actionable item cards) | 2 | **N** (structured action extraction; notes exist → partial R) |
| 28 | Collapsed "Transcript (Merged Stems)" with segment/word counts | 2 | **N** (merged-stem transcript view) |
| 29 | Chat: assistant/user bubbles, rich markdown answers, inline source citations | 3 | R (chat exists; citations + styling new → partial N) |
| 30 | User message as solid indigo bubble, right-aligned | 3 | R (restyle) |
| 31 | Suggested follow-up prompt chips | 3 | **N** |
| 32 | Composer: token counter (2,410/128k), Web toggle, Add file, clear | 3 | **N** (token meter, web toggle, file attach) |
| 33 | "Context loaded" strip with document chips + model selector (Claude 3.5 Sonnet) | 3 | **N** (visible context management + model choice) |
| 34 | Source Documents sidebar (3 indexed docs w/ pages, open links) | 3 | **N** |
| 35 | "Next Deliverable" widget: circular progress ring 65%, due countdown chip, checklist with done/undone | 3 | **N** |
| 36 | "Team Protocols" panel (team policy notes + next meeting) + "Add to Team Policy" button in chat | 3 | **N** |
| 37 | Answer callouts (red yes/no summary bar) | 3 | **N** |
| 38 | Materials stat cards (files/folders, MB processed, embeddings-ready, semester anchor) | 4 | **N** |
| 39 | Drag-and-drop file/folder upload zone + New Folder + supported-format chip | 4 | **N** (rich ingest UI; file ingest exists → partial R) |
| 40 | Semester-start date field with "calculates dynamic week offsets" helper | 4 | **N** |
| 41 | Expand All / Select Visible bulk controls | 4 | **N** |
| 42 | Hierarchical file-explorer tree table (folders, nested folders, indent, category, size, per-row actions: download, tag, delete, folder-level download-all) | 4 | **N** (file explorer tree) |
| 43 | Large-file size emphasis (cyan) + system-hidden `.index` folder | 4 | **N** |
| 44 | Sync-daemon status strip (watching path, auto-indexing, last polled) | 4 | **N** (live watcher telemetry) |
| 45 | "Ask AI across N Indexed Materials" CTA with Launch Ask AI | 4 | **N** (RAG-from-materials entry point; chat exists → partial R) |
| 46 | Daemon status bar: PID, next scheduled session, last scan, Pause Joining / Reset Scan / Manual Scan | 5 | **N** (daemon controls) |
| 47 | Completed Sessions capture list (size, format, seg IDs, Done/Archived, open folder) + total-captured stat | 5 | **N** (capture archive dashboard) |
| 48 | Live Activity Stream event log with colored source tags + Gemini token/storage mini-stats | 5 | **N** |
| 49 | Automation Directives toggles: Auto-Pull Daily Schedule, Auto-Join & Record Next Call | 5 | **N** (automation controls; join logic exists backend-side → UI is new) |
| 50 | Calendar timeline day-view strip w/ event blocks + current-time indicator + legend | 5 | **N** (calendar board exists → timeline strip is partial R/N) |
| 51 | 3-Day Range toggle / Day View switcher | 5 | **N** |
| 52 | Agenda list w/ attendance states (`attended — persisted`, `not joined · queued`, `not joined`), Autopilot Target chip, Lab Session chip, section day headers with counts | 5 | **N** (attendance tracking + autopilot tagging) |
| 53 | Settings hero with Active Fallback / Current Daemon / Failover Policy trio | 6 | **N** (failover policy is new) |
| 54 | Transcribe & Summarize master toggle card w/ 429 auto-failover description | 6 | **N** (pipeline toggle UI; settings panel exists → partial R) |
| 55 | Stepper numeric fields with unit chips (Retention Days, Live Batch Size, Manual Batch Size, Early Join Lead) | 6 | **N** |
| 56 | Dynamic Failover Sequence: numbered draggable model pills w/ arrows + raw list | 6 | **N** (model failover chain editor) |
| 57 | API vault: masked keys, "set: settings***xxxx" status, Set / use env, GLM base URL + Ping | 6 | **N** (multi-provider key vault w/ Ping) |
| 58 | OAuth Token Exchange / Docker Keyring validation + SYNCED badge | 6 | **N** |
| 59 | Model Fallback Chain & Quota Monitor table (per-model status, RPM/RPD, last dispatched, Probe Quotas, PRIMARY badge) | 6 | **N** (quota observability) |
| 60 | HTTP 429 / quota-tier explainer callout | 6 | **N** |
| 61 | Config state bar: "Unsaved modifications in staging" + Purge Raw Segments + Save Changes | 6 | **N** (staging/dirty-state flow; destructive purge new) |

---

## Feature gap analysis vs current app

Current app inventory (frontend/src/app): courses list w/ deadlines panel, calendar board/list, course detail w/ sessions (transcripts, audio, notes), chat tab (AI assistant), materials tab (file ingest), settings panel, navbar, backend bar.

### RESTYLE — already exists, new look

| Screenshot feature | Existing component |
|---|---|
| Global navbar (logo, 3-tab nav Schedule/Courses & Deadlines/Settings) | `navbar.tsx` |
| Footer daemon/backend status bar | `backend-bar.tsx` |
| Courses list + deadlines panel (hero, deadline rows w/ course codes, due dates, descriptions) | `courses/`, `deadlines-panel.tsx` |
| Course code tags, due-date chips, per-course action buttons | `deadlines-panel.tsx` |
| Register Course form (course code + semester start) | `course-new.tsx` |
| Meeting→Course mapping manager (title pattern → folder, active mappings, remove) | `mapping-manager.tsx` (partially — new polish: counts, override copy, full-width Link button) |
| Update/Rebuild actions | existing daemon actions |
| Course hero + Sessions/Materials/Ask tabs | `course/` (new segmented-pill chrome = restyle) |
| Session list w/ dates, recorded/transcribed state, play recording, delete | `course/` sessions |
| Audio playback w/ scrubber + time | `course/` audio player (speed 1.25x & captions = new) |
| Transcripts + class notes / AI summaries | `course/` transcripts & notes |
| Chat thread w/ assistant/user messages, model | `course/` chat tab (rich markdown, citations, chips, token meter = new) |
| Materials file ingest (upload, files list, Ask AI over materials) | `course/` materials tab (tree/table & metadata = new) |
| Calendar day view + session list w/ times, courses, join states | `calendar-board.tsx`, `calendar-list.tsx` (timeline strip & attendance states = new) |
| Settings panel (transcription toggles, API key inputs, model selection) | `settings-panel.tsx`, `settings/` (failover chain, vault, quota table = new) |
| Ask AI entry points (course-level) | `course/` chat tab |
| Course repo list w/ edit/rename/delete | `courses/`, `course-rename.tsx`, `course-delete.tsx` |

### NEW-FEATURE — does not exist yet, worth implementing

Priority-ordered observations from the screenshots:

1. **⌘K quick filter / global search** — navbar pill on all 6 screens; command-palette-style filtering.
2. **KPI stat cards / dashboard header** — "108 Open / 37 Done / 1 Overdue / 7 Directories" summary row (Courses screen); also materials stats (16 files, 68.4 MB, embeddings-ready, semester anchor).
3. **Deadline filtering + search + counts** — "This Week (26) / Later (79) / Done (37)" tabs, per-page text filter, date-window sections ("IMMEDIATE DELIVERABLES OCT 07 — OCT 14").
4. **Overdue surfacing** — red-tinted rows, `OVERDUE (3D)` badges.
5. **Bulk selection** — checkboxes on deadline rows and file-tree rows + "Select Visible" (enables future bulk actions).
6. **Inline progress tracking** — "Progress: 0/11 tasks" per assignment; progress rings (65% deliverable widget in chat screen).
7. **Per-item micro-actions** — Ask AI / +Checklist / Note / Study Plan buttons on individual deadlines and milestones.
8. **Milestone spread-planner** — "Worth Spreading Out / Upcoming Milestones" cards with weight/impact and start dates.
9. **Whisper Daemon Listener card** — live capture-daemon telemetry visible on Courses screen.
10. **Registered Course Repositories dashboard** — indexed-session counts per course, register-course inline form, "attic" unassigned-ingress bucket, "Ingest Manual Audio File".
11. **Session pipeline telemetry** — "recorded · transcribed · 12 segments merged", segment/word counts, Re-transcribe & "move to…" actions.
12. **Merged-stem transcript view** — "Transcript (Merged Stems)" collapsed row.
13. **Structured AI session notes** — OVERVIEW + KEY TOPICS + KEY MILESTONES & ACTIONS with actionable item cards and inline timestamps.
14. **Week grouping / sprint labels** on session lists ("Week 5 · CURRENT SPRINT", "Week 4 · ARCHIVED · 2 RECORDINGS").
15. **Audio player upgrades** — playback speed (1.25x), captions/subtitles button, speaker metadata ("Prof. Aris Thorne · Stereo 48kHz · Lossless Opus").
16. **Chat context strip** — "Context loaded: Evaluation Scheme.pdf · Lecture Transcripts" chips + model selector (Claude 3.5 Sonnet).
17. **Chat citations & rich components** — inline document citations w/ page ranges, numbered sections w/ category badges, info callouts, red answer-summary callouts with "Add to Team Policy".
18. **Suggested prompt chips** in chat.
19. **Composer upgrades** — token counter (2,410/128k), "Web off" toggle, "Add file" attach.
20. **Source Documents sidebar** — indexed doc list with page ranges and open links.
21. **Next Deliverable widget** — countdown chip, progress ring, interactive checklist (done/undone).
22. **Team Protocols panel** — team policy notes + next meeting row.
23. **File explorer tree** — hierarchical folder tree table (Week 1/2/3, nested "Project Proposal", loose root resources), category tags, sizes, download/tag/delete per row, folder download-all, hidden `.index` system folder, Expand All.
24. **Drop-zone upload** — drag-and-drop with format chip (ZIP/PDF/DOCX/MP4), New Folder.
25. **Semester-start date → dynamic week offsets** helper on Materials screen.
26. **Sync daemon strip** — "watching folder /mnt/courses/…, auto-indexing, last polled 2m ago".
27. **"Ask AI across N Indexed Materials"** RAG entry point with Launch Ask AI.
28. **Schedule/automation dashboard** — daemon status bar (PID, next session, last scan, Pause Joining / Reset Scan / Manual Scan).
29. **Completed Sessions capture archive** — captures with MB sizes, formats (.webm), seg IDs, Done/Archived badges, "1.24 GB Total Captured", open-folder actions.
30. **Live Activity Stream** — colored daemon event log ([deadlines]/[schedule]/[mux]/[ai-notes]/[gemini]) + Gemini tokens today + storage-used stats.
31. **Automation Directives toggles** — Auto-Pull Daily Schedule (LMS scan 06:00), Auto-Join & Record Next Call (audio tap 60s pre-start).
32. **Calendar timeline strip** — hour-axis day view with event blocks + current-time indicator + legend; Day View / 3-Day Range switcher.
33. **Attendance & autopilot states** — `attended — persisted` / `not joined · queued` / `not joined`, `Autopilot Target` chip, `Lab Session` chip, day-group headers with counts.
34. **Failover policy config** — hero trio (Active Fallback "7 Tiered", Current Daemon, Failover Policy "Eager Backoff").
35. **Pipeline stepper fields** — Retention (days), Live Batch Size, Manual Batch Size, Early Join Lead w/ unit chips and −/+ controls.
36. **Dynamic Failover Sequence editor** — numbered draggable model pills with arrows + RAW_LIST view.
37. **Multi-provider API vault** — Gemini + GLM masked keys, `set: settings***xxxx` state, "use env" source toggle, GLM Base URL + Ping test.
38. **OAuth Token Exchange** validation via local Docker Keyring with SYNCED badge.
39. **Model Fallback Chain & Quota Monitor table** — per-model availability, RPM/RPD quota columns, last-dispatched times, Probe Quotas action, PRIMARY badge, 429/quota-tier explainer.
40. **Config staging flow** — "Unsaved modifications in staging", Purge Raw Segments (destructive red), Save Changes sticky bar.

### Cross-cutting implementation notes

- Screens 2–4 share a **course-detail shell** (breadcrumb + segmented tabs + hero) that should become the single `course/` layout: `Sessions | Materials | Ask` with live counts, plus a right sidebar slot (Source Documents / Next Deliverable / Team Protocols only on Ask; mapping + daemon cards only on Courses).
- All screens share the same **header/footer chrome**, stat-card pattern, panel-with-eyebrow pattern, chip/badge system, and micro-action button system — these should be built once as design-system primitives before per-screen work.
- The DESIGN.md token dump (Safe Linear System) matches the screenshots' actual palette; note the screenshots' prose-described zinc palette (`#09090b`/`#18181b`/`#27272a`) vs token-dump surfaces (`#12131a`/`#1e1f26`) — pick one base set (recommend token dump as `:root` truth, with prose values as hover/line aliases) and stick to it when porting to `globals.css`.
