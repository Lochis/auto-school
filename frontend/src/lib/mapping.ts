/** Meeting-title → folder mapping, stored in <data>/mapping.json.
 *  The backend's parseCourse() reads the same file, so UI edits apply to the
 *  very next session. Also surfaces unmapped candidate titles from the
 *  backend's scan artifacts (calendar dump + timeline log). */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./data";

const MAPPING_FILE = join(DATA_DIR, "mapping.json");

export type Mapping = Record<string, string>;

export function readMapping(): Mapping {
  try {
    const raw = JSON.parse(readFileSync(MAPPING_FILE, "utf8"));
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim(), String(v).trim()]));
  } catch {
    return {};
  }
}

export function writeMapping(m: Mapping): void {
  writeFileSync(MAPPING_FILE, JSON.stringify(m, null, 2) + "\n");
}

/** Existing course folders (union of recordings/ + notes/) — mapping targets. */
export function folders(): string[] {
  const out = new Set<string>();
  for (const base of ["recordings", "notes"]) {
    try {
      for (const d of readdirSync(join(DATA_DIR, base), { withFileTypes: true })) {
        if (d.isDirectory()) out.add(d.name);
      }
    } catch { /* none */ }
  }
  return [...out].sort();
}

/** Distinct meeting titles the backend has seen but that aren't mapped yet. */
export function candidateTitles(mapping: Mapping): string[] {
  const titles = new Set<string>();
  // calendar dump lines: start | end | online | joinable | title
  try {
    const lines = readFileSync(join(DATA_DIR, "out", "calendar-events.txt"), "utf8").split("\n");
    for (const l of lines) {
      const parts = l.split(" | ");
      const title = parts[parts.length - 1]?.trim();
      if (title && parts.length === 5) titles.add(title);
    }
  } catch { /* none */ }
  // timeline log: one JSON per line with a "meeting" field
  try {
    for (const l of readFileSync(join(DATA_DIR, "out", "timeline.jsonl"), "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { titles.add(JSON.parse(l).meeting); } catch { /* skip */ }
    }
  } catch { /* none */ }
  return [...titles].filter((t) => t && !(t in mapping)).sort();
}
