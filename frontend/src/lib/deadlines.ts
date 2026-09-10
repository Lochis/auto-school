/** Server-side read of the AI-built deadline calendar
 *  (<data>/user-data/deadlines.json — written by the backend rebuild). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./data";

export interface DeadEntry {
  course: string;
  title: string;
  due: string | null;
  kind: string;
  spread: boolean;
  startBy: string | null;
  note: string;
  source: string;
  confidence: string;
}

export function readDeadlines(): DeadEntry[] {
  try {
    const j = JSON.parse(readFileSync(join(DATA_DIR, "user-data", "deadlines.json"), "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

export function deadlinesExist(): boolean {
  return existsSync(join(DATA_DIR, "user-data", "deadlines.json"));
}
