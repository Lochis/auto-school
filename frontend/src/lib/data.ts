/** Read the backend's data root (same PVC, mounted at /data in the pod).
 *  Layout produced by src/pipeline/courses.ts + consolidate.ts:
 *    /data/recordings/<course-slug>/<YYYY-MM-DD>__<slug>.mp4
 *    /data/notes/<course-slug>/<YYYY-MM-DD>__<slug>__notes.md
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR =
  process.env.AUTO_SCHOOL_DATA && process.env.AUTO_SCHOOL_DATA !== "."
    ? process.env.AUTO_SCHOOL_DATA
    : ".";

export interface Session {
  /** "2026-08-20__Java_Programming" */
  stem: string;
  date: string;
  /** path under DATA_DIR of the mp4, if present */
  audio?: string;
  /** path under DATA_DIR of the notes md, if present */
  notes?: string;
  /** path under DATA_DIR of the raw transcript md, if present */
  transcript?: string;
  /** path under DATA_DIR of the timeline json (live-pipeline transcripts), if present */
  timeline?: string;
  /** segments captured for this session (from the timeline) */
  segmentCount?: number;
  /** HH:MM — from the mp4's time suffix, else the notes file's first-write time */
  time?: string;
  hasTimeline: boolean;
}

function dirs(base: string): string[] {
  try {
    return readdirSync(join(DATA_DIR, base), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Union of course folders found under recordings/ and notes/ */
export function courses(): string[] {
  return [...new Set([...dirs("recordings"), ...dirs("notes")])].sort();
}

export function sessions(course: string): Session[] {
  const byStem = new Map<string, Session>();
  const add = (stem: string, patch: Partial<Session>) => {
    const s = byStem.get(stem) ?? {
      stem,
      date: stem.slice(0, 10),
      hasTimeline: false,
    };
    byStem.set(stem, { ...s, ...patch });
  };
  // time-of-day: explicit __THHMMSS mp4 suffix wins, else first notes write
  const timeFromStem = (stem: string): string | undefined => {
    const m = stem.match(/__T?(\d{2})(\d{2})\d{2}$/);
    return m ? `${m[1]}:${m[2]}` : undefined;
  };
  try {
    for (const f of readdirSync(join(DATA_DIR, "recordings", course))) {
      if (f.endsWith(".mp4")) {
        const stem = f.replace(/\.mp4$/, "");
        add(stem, { audio: `recordings/${course}/${f}`, time: timeFromStem(stem) });
      }
    }
  } catch { /* none */ }
  try {
    for (const f of readdirSync(join(DATA_DIR, "notes", course))) {
      if (f.endsWith("__notes.md") || f.endsWith("__running.md")) {
        const stem = f.replace(/__(notes|running)\.md$/, "");
        const mt = statSync(join(DATA_DIR, "notes", course, f)).mtime;
        const hh = String(mt.getHours()).padStart(2, "0");
        const mm = String(mt.getMinutes()).padStart(2, "0");
        add(stem, { notes: `notes/${course}/${f}`, time: timeFromStem(stem) ?? `${hh}:${mm}` });
      }
      if (f.endsWith("__transcript.md")) add(f.replace(/__transcript\.md$/, ""), { transcript: `notes/${course}/${f}` });
      if (f.endsWith("__timeline.json")) {
        let n: number | undefined;
        try { n = JSON.parse(readFileSync(join(DATA_DIR, "notes", course, f), "utf8")).length; } catch { /* unreadable */ }
        add(f.replace(/__timeline\.json$/, ""), { hasTimeline: true, timeline: `notes/${course}/${f}`, ...(typeof n === "number" ? { segmentCount: n } : {}) });
      }
    }
  } catch { /* none */ }
  return [...byStem.values()].sort((a, b) => (b.date + (b.time ?? "")).localeCompare(a.date + (a.time ?? ""))); // newest first
}

/** Read a text file (notes markdown) safely under DATA_DIR. */
export function readText(rel: string): string | null {
  const file = join(DATA_DIR, rel);
  if (!file.startsWith(DATA_DIR) || !existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Render the live pipeline's timeline.json as transcript markdown:
 *  one "[m:ss] text" block per segment, segments with no speech skipped. */
export function timelineToMd(rel?: string): string | null {
  if (!rel) return null;
  try {
    const j = JSON.parse(readText(rel) ?? "null");
    if (!Array.isArray(j)) return null;
    const lines = (j as { offsetSec: number; transcript?: string }[])
      .filter((e) => e?.transcript?.trim())
      .map((e) => {
        const m = Math.floor(e.offsetSec / 60);
        const s = String(Math.round(e.offsetSec % 60)).padStart(2, "0");
        return `**[${m}:${s}]** ${e.transcript!.trim()}`;
      });
    return lines.length ? `# Transcript\n\n${lines.join("\n\n")}` : null;
  } catch {
    return null;
  }
}
