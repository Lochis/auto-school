/** Per-session pipeline state, persisted to /data/out/sessions.json.
 *  Every stage transition upserts one row; the UI shows a live progress line
 *  per session (recording → remuxing → transcribing k/n → noting →
 *  consolidating → done | failed). Survives restarts — answers "what is it
 *  doing to my recording?" structurally instead of via log grepping. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { OUT_DIR } from "../paths.ts";

export type Stage = "recording" | "remuxing" | "transcribing" | "noting" | "consolidating" | "done" | "failed";

export interface SessionState {
  stem: string; // segment stem (title__ISO) — stable id for the whole pipeline
  title: string;
  course?: string;
  startedAt: number;
  updatedAt: number;
  stage: Stage;
  stageNote?: string; // e.g. "3/12 segments through Gemini"
  segCount?: number;
  mp4?: string; // recordings/<course>/<file>.mp4 once done
  durationSec?: number;
  sizeMB?: number;
  joinUrl?: string; // Teams meeting link for this session (from Graph or calendar scrape)
}

const FILE = `${OUT_DIR}/sessions.json`;
let sessions: SessionState[] = [];

function load(): void {
  try { sessions = JSON.parse(readFileSync(FILE, "utf8")); } catch { sessions = []; }
}
load();

function save(): void {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(sessions.slice(0, 100), null, 1));
  } catch { /* read-only fs — in-memory only */ }
}

export function updateSession(stem: string, patch: Partial<Omit<SessionState, "stem">>): SessionState {
  let s = sessions.find((x) => x.stem === stem);
  if (!s) {
    s = { stem, title: stem.replace(/__\d{4}-\d{2}-\d{2}.*$/, "").replace(/_/g, " "), startedAt: Date.now(), updatedAt: Date.now(), stage: "recording" };
    sessions.unshift(s);
  }
  Object.assign(s, patch, { updatedAt: Date.now() });
  save();
  return s;
}

export function listSessions(): SessionState[] {
  return sessions.slice(0, 50);
}
