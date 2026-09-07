/** Course categorization: parse class identity out of meeting titles. */
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { NOTES_DIR, DATA_DIR } from "../paths.ts";

/** Manual title → folder overrides from <data>/mapping.json (managed via the UI).
 *  Exact title match wins over pattern parsing; invalid JSON is ignored. */
function mappingOverrides(): Map<string, string> {
  try {
    const raw = JSON.parse(readFileSync(`${DATA_DIR}/mapping.json`, "utf8"));
    return new Map(Object.entries(raw).map(([k, v]) => [k.trim(), String(v).trim()]));
  } catch {
    return new Map();
  }
}

export interface CourseInfo {
  /** e.g. "26M" — semester/cohort tag, or "GEN" if none found */
  code: string;
  /** e.g. "Java_Programming" — slug for folders/files */
  slug: string;
  /** human name, e.g. "Java Programming" */
  name: string;
}

/** Extract course from a meeting title. Known patterns:
 *  "26M --Java Programming (SEC. 401)"
 *  "2nd half - 26M --Software Systems Design (SEC. 401)"
 *  fallback: first 4+ words of the title. */
export function parseCourse(meetingTitle: string): CourseInfo {
  const mapped = mappingOverrides().get(meetingTitle.trim());
  if (mapped) {
    return { code: "MAP", slug: mapped, name: mapped.replace(/_/g, " ") };
  }
  // strip section markers
  let t = meetingTitle.replace(/\(SEC\.?\s*[^)]*\)/gi, "").trim();
  // "<prefix> - <code> --<Name>" or "<code> --<Name>"
  const m = t.match(/(\b[A-Z0-9]{2,4}[A-Z0-9]*)\s*--\s*(.+)/) ?? t.match(/(\b[A-Z0-9]{2,4})\s*[-–]\s*(.+)/);
  if (m) {
    const name = m[2].trim();
    return { code: m[1], slug: `${m[1]}-${slug(name)}`, name };
  }
  // no pattern: use title words
  const words = t.split(/\s+/).slice(0, 4).join(" ") || "General";
  return { code: "GEN", slug: slug(words) || "General", name: words };
}

export function slug(s: string): string {
  return s.replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_").slice(0, 60);
}

/** The notes directory for a course (created on demand). */
export function courseDir(course: CourseInfo, base = NOTES_DIR): string {
  const dir = `${base}/${course.slug}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Dated filename stem for a session: notes/<course>/<date>__<course>__notes.md */
export function sessionPaths(meetingTitle: string, date = new Date()): {
  notesMd: string; runningMd: string; timelineJson: string; dir: string; course: CourseInfo; stem: string;
} {
  const course = parseCourse(meetingTitle);
  const dir = courseDir(course);
  // local date ("sv-SE" → YYYY-MM-DD) — an 8pm class must not land on tomorrow via UTC
  const stem = `${date.toLocaleDateString("sv-SE")}__${course.slug}`;
  return {
    course, dir, stem,
    notesMd: `${dir}/${stem}__notes.md`,
    runningMd: `${dir}/${stem}__running.md`,
    timelineJson: `${dir}/${stem}__timeline.json`,
  };
}

/** Rebuild notes/INDEX.md from the on-disk tree. Called after every finalize. */
export function rebuildIndex(base = NOTES_DIR): void {
  const courses: { slug: string; sessions: { file: string; stem: string; topics: string }[] }[] = [];
  try {
    
    for (const c of readdirSync(base, { withFileTypes: true })) {
      if (!c.isDirectory()) continue;
      const sessions = readdirSync(`${base}/${c.name}`)
        .filter((f) => f.endsWith("__notes.md"))
        .sort()
        .map((f) => {
          let topics = "";
          try {
            const md = readFileSync(`${base}/${c.name}/${f}`, "utf8");
            const kt = md.match(/## Key Topics\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
            topics = kt.split("\n").filter((l) => l.trim().startsWith("-")).slice(0, 3)
              .map((l) => l.replace(/^-\s*/, "").replace(/\*\*/g, "").slice(0, 80)).join(" · ");
          } catch { /* unreadable */ }
          return { file: f, stem: f.replace("__notes.md", ""), topics };
        });
      if (sessions.length) courses.push({ slug: c.name, sessions });
    }
  } catch { /* no notes dir yet */ }

  let md = `# Class Notes Index\n\n`;
  for (const c of courses) {
    md += `## ${c.slug.replace(/_/g, " ")}\n`;
    for (const s of c.sessions) {
      const date = s.stem.split("__")[0];
      md += `- **${date}** — [session notes](./${c.slug}/${s.file})${s.topics ? ` — ${s.topics}` : ""}\n`;
    }
    md += `\n`;
  }
  writeFileSync(`${base}/INDEX.md`, md);
}
