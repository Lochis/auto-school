/** Incremental notes — DAEMON ADAPTER (5b-2 c, D4).
 *
 *  The generator itself now lives in `src/db/gen/notes.ts` (bundleable: PG +
 *  raw LLM transport only), and this file is the daemon-side wrapper that adds
 *  exactly what the platform must NOT have:
 *    - the QUOTA-AWARE text call (pipeline/llm.ts `textCall`: GLM→Gemini chain,
 *      429 learning, model rotation, activity feed)
 *    - the fs session paths (`sessionPaths` → notes/<slug>/<stem>, incl. its
 *      mkdir side effect) so folder naming stays identical to the pre-5b2c code
 *    - the post-finalize tail: `rebuildIndex()` → embed kick → `notify()`
 *    - `pushEvent()` board messages
 *
 *  ONE implementation, no drift: both processes run gen/notes.ts with the same
 *  prompts, fold logic and write targets (session_artifacts running_notes /
 *  notes / timeline + transcript_segments). The only behavioural delta is log
 *  ordering — gen logs "✓ final notes written" before onFinalized runs, where
 *  the old code logged after rebuildIndex() — and, for the manual-transcribe
 *  path that passes explicit `paths`, `sessionPaths()` is no longer called
 *  inside finalize (so no notes/<parsedCourse>/ mkdir for that one case; the
 *  notes themselves are PG rows and the dir was never read).
 *  (Segments/notes are now PG-only, so the mkdir was already vestigial.)
 *
 *  Kept as a stable import surface for src/daemon.ts:41 and
 *  src/record/recorder.ts:15 (`foldSegments`, `finalizeNotes`, `foldSegment`).
 */
import { notify } from "../notify.ts";
import { pushEvent } from "../status.ts";
import type { TimelineEntry } from "./segment.ts";
import { sessionPaths, rebuildIndex } from "./courses.ts";
import { textCall } from "./llm.ts";
import {
  foldSegment as genFoldSegment,
  foldSegments as genFoldSegments,
  finalizeNotes as genFinalizeNotes,
} from "../db/gen/notes.ts";

/** Fold a single entry into the running summary (daemon policy wrapper). */
export async function foldSegment(meeting: string, entry: TimelineEntry): Promise<string> {
  const summary = await genFoldSegment(meeting, entry, daemonOpts(meeting));
  pushEvent(`notes: running summary updated (${summary.split(/\s+/).length} words)`);
  return summary;
}

/** Fold entries (one call per batch — cheap on GLM). */
export async function foldSegments(meeting: string, entries: TimelineEntry[]): Promise<string> {
  const summary = await genFoldSegments(meeting, entries, daemonOpts(meeting));
  pushEvent(`notes: running summary updated (${summary.split(/\s+/).length} words)`);
  return summary;
}

/** Final pass: running summary + full timeline -> polished class notes. */
export async function finalizeNotes(
  meeting: string,
  timeline: TimelineEntry[],
  paths?: { notesMd: string; runningMd: string; timelineJson: string; dir: string; course: import("./courses.ts").CourseInfo; stem: string },
): Promise<string> {
  const p = paths ?? sessionPaths(meeting);
  return genFinalizeNotes(meeting, timeline, {
    callText: textCall,
    target: { slug: p.course.slug, stem: p.stem },
    onFinalized: async () => {
      rebuildIndex();
      // EMBED — make the fresh notes/timeline semantically searchable right away
      // (fire-and-forget; no-op when PG/Gemini key absent).
      try {
        const { embedPendingSessions } = await import("../db/ingest-embed.ts");
        void embedPendingSessions().catch(() => { });
      } catch { /* db layer absent in fs-only dev */ }
      await notify(`📝 Class notes ready: **${p.course.name}** → notes/${p.course.slug}/${p.stem}__notes.md`);
    },
  });
}

/** Quota-aware call + fs-derived identity for the daemon's fold path. */
function daemonOpts(meeting: string) {
  const p = sessionPaths(meeting); // also creates notes/<slug>/ (legacy side effect)
  return { callText: textCall, target: { slug: p.course.slug, stem: p.stem } };
}
