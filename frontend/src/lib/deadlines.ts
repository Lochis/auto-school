/** Server-side read of the AI-built deadline calendar
 *  (<data>/user-data/deadlines.json — written by the backend rebuild). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./data";

export interface DeadEntry {
  id: string;
  course: string;
  title: string;
  due: string | null;
  kind: string;
  spread: boolean;
  startBy: string | null;
  note: string;
  source: string;
  confidence: string;
  done?: boolean;
  doneAt?: number | null;
  stale?: number;
}

export function readDeadlines(): DeadEntry[] {
  try {
    const j = JSON.parse(readFileSync(join(DATA_DIR, "user-data", "deadlines.json"), "utf8"));
    if (!Array.isArray(j)) return [];
    // duplicate ids break the panel's React keys (rows bleed across tabs
    // until a hard refresh) — first occurrence wins, later ones get a
    // deterministic ~N suffix (the daemon also self-heals the stored file)
    const seen = new Set<string>();
    return j.map((d: DeadEntry) => {
      let id = d.id ?? "";
      if (!id || seen.has(id)) {
        let n = 1;
        while (seen.has(`${id}~${n}`)) n++;
        id = `${id}~${n}`;
      }
      seen.add(id);
      return { ...d, id };
    });
  } catch {
    return [];
  }
}

export function deadlinesExist(): boolean {
  return existsSync(join(DATA_DIR, "user-data", "deadlines.json"));
}
