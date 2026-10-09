# UI Overhaul — QA Confirmation Pass (post-fix)

Re-captured: `/tmp/as-qa/shots/` (courses, sessions, sessions-session, chat, materials, settings, schedule).
Prior findings: `stitch/QA-REPORT.md`. Verdicts below are from the fresh captures only.

---

## Defect verification

| # | DEFECT | STATUS | EVIDENCE |
|---|---|---|---|
| 1 | Schedule title locale mismatch (`Wednesday 7 Oct` vs `Wednesday, Oct 7`) | RESOLVED (visible) | schedule.png panel reads `Calendar — Wednesday, Oct 7` — single en-US format; hydration console errors not verifiable from static PNG, but the mismatch string is gone |
| 2 | Courses missing "Worth Spreading Out / Upcoming Milestones" panel | RESOLVED | courses.png shows `WORTH SPREADING OUT / Upcoming Milestones` panel with `5 items` chip, `Collapse ^`, and 5 milestone cards (Study Plan/Checklist chips, High Impact tag); card count is data-driven, chip itself present |
| 3 | Footer daemon status bar absent on non-root pages | RESOLVED | `AUTOSCHOOL DAEMON // IDLE … LAST SCAN: 7:36 PM [Pause joining][Scan(reset)][Scan] LISTENER: STEREO 48KHZ PIPELINE READY` renders on courses/sessions/session/chat/materials/settings/schedule captures |
| 4 | Session detail: raw markdown dump below structured summary | PARTIAL | sessions-session.png still shows bold `Class Notes — 26F - COMP231 - (SEC. 401) - Lab` + `User Role Modeling [10:00] — …` below the milestone cards; `KEY TOPICS` eyebrow is now styled, but the dump remains and content is still the 10-02 lab's |
| 5 | Chat ask-route: blank breadcrumb panel + missing Add file chip | RESOLVED | chat.png breadcrumb strip now reads `← All Courses / 26F` + `Sessions \| Materials \| Ask` pills; composer shows `📎 Add file` beside `🌐 Web off` / `tokens: 0 / 128k` |
| 6 | Courses: tall deadline rows + repo-card trash/SESSIONS clutter | PARTIAL | Rows are tighter (chip-based due badges: `Due Tomorrow`, `Oct 09 (in 2d)`) but still carry a description line + `Ask AI`/`+ Checklist` chips + 4 icon buttons, and titles still wrap 2 lines. Repo `SESSIONS` buttons gone, but red trash icons remain on every card and titles still wrap to 2 lines |
| 7 | Sessions: session-card action bar not compact | PARTIAL | `move to…` is now a compact inline select (no longer full-width) — e.g. `2026-10-06 · 8:22 PM` card: `[move to… ▾][🗑 Delete]` on one row; but recorded cards still split `Play recording` onto a second row instead of a single action bar |
| 8 | Materials copy drift + category column | PARTIAL | Fixed: drop-zone chip now `ZIP / PDF / DOCX / MP4`, button now `New Folder`, CATEGORY values now plain text (`week 1/2/3`, `root`). Not fixed: parser stat still says `Ask Pipeline Ready` (mockup `Embeddings Ready`); category values still rendered as colored chips, not plain text |
| 9 | Settings vault set-status / quota header / sticky config bar | PARTIAL | Vault key wells show masked values (`Aiza…`, `Zhipu coding-plan key…` + `Set`/`use env`) but no `● set: settings***xxxx` status text. Quota header now has `1 cooling down` chip + 429 explainer (no `All Healthy`/`Probe Quotas` — `All Healthy` is data-driven since gemini-2.5-pro is cooling down, but `⟳ Probe Quotas` action still absent). Config-state bar is now a full-width action bar (`● Config state: Synchronized — no pending changes` + Purge Raw Segments + Save Changes) but still positioned mid-page between vault and quota table; stickiness not verifiable in a static capture |
| 10 | Schedule daemon bar missing PID chip | STILL BROKEN | Neither the top `● DAEMON IDLE` bar nor the footer daemon bar on schedule.png shows a `PID: …` chip |

---

## Remaining P1 / P2

**P1**
1. **Session detail (sessions-session.png)** — the unstyled notes dump (`Class Notes — 26F - COMP231 - (SEC. 401) - Lab`, `User Role Modeling [10:00] — …`) still renders below the structured summary, and its content belongs to the 10-02 lab session, not the 10-06 kickoff it appears under. Eyebrow styling was applied but the dump itself and the wrong-session data remain.

**P2**
2. **Schedule** — no `PID:` chip in either the top daemon bar or the footer daemon bar.
3. **Settings** — vault wells lack `● set: …` per-key status text; `⟳ Probe Quotas` missing from quota header; config-state bar still sits mid-page (placement/stickiness unresolved in capture).
4. **Courses** — deadline rows still 2× mockup height (wrapped titles + description line + 6 controls per row); repo cards still wrap to 2 lines and keep red trash icons.
5. **Sessions** — recorded session cards still put `Play recording` on a second row (mockup: single inline action bar); transcript rows still show `12 segments` with no word counts.
6. **Materials** — parser stat copy `Ask Pipeline Ready` (mockup `Embeddings Ready`); CATEGORY column values fixed but still colored chips rather than plain text.
7. **All pages** — footer daemon bar renders above the legacy `▶ Daemon details — sessions, activity & up next` collapsible rather than at document end (bar itself is now present everywhere; ordering/position nit remains).
8. **Schedule directives** — second toggle still `Live Transcribe & Summarize` instead of mockup `Auto-Pull Daily Schedule` (carried over from prior report; unchanged).

Not re-flagged (data-driven / not defects): milestone card count (`5 items`), `1 cooling down` vs `All Healthy`, empty calendar body, `tokens: 0 / 128k`, `no recording` states, materials `Sync daemon: Idle`, `ACTIVE SEMESTER ANCHOR not set`, Next.js dev-mode "N" badge.
