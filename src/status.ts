/** In-memory status board: the daemon's controller serves it at /status and
 *  the frontend renders it. Every pipeline stage reports here so the UI can
 *  show what's happening now and what happens next. */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, OUT_DIR } from "./paths.ts";
import { listSessions } from "./pipeline/sessions.ts";

export interface StatusEvent { ts: string; msg: string }

export interface Settings { transcribe: boolean }

export interface ModelQuota {
  model: string;
  available: boolean;        // false = hard-failed (404/403) — dropped from the chain
  exhausted: boolean;        // true = cooling down after a 429
  exhaustedUntil: number | null; // epoch ms — auto-recovers after this
  exhaustedReason: string | null; // "rpm" | "rpd" | "quota"
  rpmLimit: number | null;   // learned from 429 body (quotaValue, PerMinute)
  rpdLimit: number | null;   // learned from 429 body (quotaValue, PerDay)
  last429: string | null;    // ISO time of last quota hit
  lastUsedAt: string | null; // ISO time of last success
}

const SETTINGS_FILE = join(DATA_DIR, "settings.json");

const modelQuotas = new Map<string, ModelQuota>();

function blank(model: string): ModelQuota {
  return { model, available: true, exhausted: false, exhaustedUntil: null, exhaustedReason: null,
    rpmLimit: null, rpdLimit: null, last429: null, lastUsedAt: null };
}

/** Register models from GEMINI_MODELS env var (idempotent). */
function initModelQuotas(): void {
  try { process.loadEnvFile(); } catch {}
  const models = (process.env.GEMINI_MODELS ?? "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-2.5-flash")
    .split(",").map(m => m.trim()).filter(Boolean);
  for (const m of models) modelQuotas.get(m) ?? modelQuotas.set(m, blank(m));
}
initModelQuotas();

export function getModelQuotas(): ModelQuota[] {
  initModelQuotas(); // pick up env edits
  for (const q of modelQuotas.values()) refreshExhaustion(q); // recover cooled-down models
  return Array.from(modelQuotas.values());
}

/** Pacific-time offset for an instant — Gemini RPD resets at PT midnight. */
function ptOffsetMs(d = new Date()): number {
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" })
    .formatToParts(d).find(p => p.type === "timeZoneName")?.value ?? "GMT-07:00";
  const m = tz.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60_000 : -7 * 3_600_000;
}

export function nextPacificMidnight(): number {
  const now = Date.now();
  const ptWall = new Date(now + ptOffsetMs(new Date(now))); // PT clock expressed as UTC
  return Date.UTC(ptWall.getUTCFullYear(), ptWall.getUTCMonth(), ptWall.getUTCDate() + 1) - ptOffsetMs(new Date(now));
}

/** "37s" | "1m30s" | "45" → seconds. */
export function parseDurSec(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let total = 0, found = false;
  for (const [, n, unit] of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)) {
    found = true;
    total += unit === "ms" ? +n / 1000 : unit === "s" ? +n : unit === "m" ? +n * 60 : +n * 3600;
  }
  return found ? Math.ceil(total) : null;
}

/** Clear a model's cooldown once elapsed; log the recovery to the activity feed. */
function refreshExhaustion(q: ModelQuota): void {
  if (q.exhausted && q.exhaustedUntil && Date.now() >= q.exhaustedUntil) {
    q.exhausted = false;
    q.exhaustedUntil = null;
    q.exhaustedReason = null;
    pushEvent(`quota: ${q.model} window reset — back in rotation`);
  }
}

export function isModelExhausted(model: string): boolean {
  const q = modelQuotas.get(model);
  if (!q) return false;
  refreshExhaustion(q);
  return q.exhausted;
}

export function isModelAvailable(model: string): boolean {
  return modelQuotas.get(model)?.available ?? true;
}

/** Parse a 429/RESOURCE_EXHAUSTED body, learn the real limits, schedule recovery,
 *  and log to the activity feed. Body shape (from live probing):
 *  quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier, quotaValue: "15",
 *  RetryInfo.retryDelay: "37s", message: "... Please retry in 37.47s." */
export function recordQuota429(model: string, body: string): void {
  const q = modelQuotas.get(model) ?? blank(model);
  modelQuotas.set(model, q);
  const daily = /PerDay/i.test(body);
  const perMin = /PerMinute/i.test(body);
  const reason = perMin ? "rpm" : daily ? "rpd" : "quota";
  const limit = body.match(/"quotaValue":\s*"?(\d+)/)?.[1];
  if (limit) {
    const n = parseInt(limit, 10);
    if (perMin && n !== q.rpmLimit) { q.rpmLimit = n; pushEvent(`quota: ${model} RPM limit detected — ${n}/min`); }
    if (daily && n !== q.rpdLimit) { q.rpdLimit = n; pushEvent(`quota: ${model} daily limit detected — ${n}/day`); }
  }
  const retrySec = parseDurSec(body.match(/"retryDelay":\s*"([^"]+)"/)?.[1])
    ?? parseDurSec(body.match(/Please retry in ([\d.]+)s/)?.[1])
    ?? 60;
  q.exhausted = true;
  q.exhaustedReason = reason;
  q.last429 = new Date().toISOString();
  q.exhaustedUntil = daily ? nextPacificMidnight() : Date.now() + retrySec * 1000;
  const until = new Date(q.exhaustedUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  pushEvent(`quota: ${model} hit its ${reason === "rpd" ? "daily" : "per-minute"} limit → cooling until ${until}, trying next model`);
}

/** Hard failure (404 model gone, 403 key) — drop from the chain for the session. */
export function markModelUnavailable(model: string, status: number): void {
  const q = modelQuotas.get(model) ?? blank(model);
  modelQuotas.set(model, q);
  if (q.available) {
    q.available = false;
    pushEvent(`model: ${model} unavailable (HTTP ${status}) — removed from chain`);
  }
}

export function noteModelUsed(model: string): void {
  (modelQuotas.get(model) ?? modelQuotas.set(model, blank(model)).get(model)!).lastUsedAt = new Date().toISOString();
}

export function getSettings(): Settings {
  try { return { transcribe: true, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) }; }
  catch { return { transcribe: true }; }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2)); } catch { /* read-only fs: in-memory only */ }
  return next;
}

/** "Same day" scoping uses the school's timezone (Centennial = Toronto). */
function localDate(d = new Date()): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d); } // YYYY-MM-DD
  catch { return d.toISOString().slice(0, 10); }
}

const LEFT_FILE = join(DATA_DIR, "left-meetings.json");

/** Titles the user manually left today — never auto-joined again today, even
 *  after a restart. Different-day meetings with the same name auto-join fine. */
export function loadLeftToday(): string[] {
  try {
    const all = JSON.parse(readFileSync(LEFT_FILE, "utf8")) as Record<string, string[]>;
    return all[localDate()] ?? [];
  } catch { return []; }
}

export function recordLeftToday(title: string): void {
  const day = localDate();
  let all: Record<string, string[]> = {};
  try { all = JSON.parse(readFileSync(LEFT_FILE, "utf8")) as Record<string, string[]>; } catch { /* fresh */ }
  const list = new Set(all[day] ?? []);
  list.add(title);
  for (const k of Object.keys(all)) if (k !== day) delete all[k]; // prune old days
  try { writeFileSync(LEFT_FILE, JSON.stringify({ [day]: [...list] }, null, 2)); } catch { /* read-only fs */ }
  pushEvent(`leave: "${title}" — won't auto-join again today`);
}

export function clearLeftToday(): void {
  try { writeFileSync(LEFT_FILE, JSON.stringify({})); } catch { /* read-only fs */ }
}

const events: StatusEvent[] = [];
export const board = {
  activity: "idle",
  detail: {} as Record<string, string | number>,
};

export function setActivity(activity: string, detail?: Record<string, string | number>): void {
  board.activity = activity;
  if (detail) board.detail = detail;
}

export function setDetail(patch: Record<string, string | number>): void {
  Object.assign(board.detail, patch);
}

let eventLog: ReturnType<typeof createAppend> | null = null;
function createAppend() {
  try { return { file: OUT_DIR + "/events.jsonl" }; } catch { return null; }
}
export function pushEvent(msg: string): void {
  events.unshift({ ts: new Date().toISOString(), msg });
  if (events.length > 60) events.length = 60;
  try { // durable tail — survives restarts, feeds the UI history
    mkdirSync(OUT_DIR, { recursive: true });
    appendFileSync(`${OUT_DIR}/events.jsonl`, JSON.stringify(events[0]) + "\n");
  } catch { /* read-only */ }
}
(function seedEvents() { // boot: restore recent history
  try {
    const lines = readFileSync(`${OUT_DIR}/events.jsonl`, "utf8").trim().split("\n").slice(-60).reverse();
    for (const l of lines) { try { events.push(JSON.parse(l)); } catch { /* skip */ } }
  } catch { /* first boot */ }
})();

export function snapshot(): { activity: string; detail: Record<string, string | number>; events: StatusEvent[]; sessions: import("./pipeline/sessions.ts").SessionState[] } {
  return { activity: board.activity, detail: board.detail, events: events.slice(0, 20), sessions: listSessions() };
}
