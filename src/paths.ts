/** Central writable-data paths.
 *
 * Everything the app writes (segments, out/, notes/, recordings/, profile)
 * lives under ONE root so a container can mount a single volume:
 *   AUTO_SCHOOL_DATA=/data  →  /data/out, /data/segments, ...
 * Default "." keeps the previous repo-relative behavior on a dev machine.
 */
import { join } from "node:path";

const root = process.env.AUTO_SCHOOL_DATA;
export const DATA_DIR = root && root !== "." ? root : ".";
const p = (name: string): string => (DATA_DIR === "." ? name : join(DATA_DIR, name));

export const OUT_DIR = p("out");
export const SEGMENTS_DIR = p("segments");
export const NOTES_DIR = p("notes");
export const RECORDINGS_DIR = p("recordings");
/** out/<file...> helper */
export const outPath = (...parts: string[]): string => join(OUT_DIR, ...parts);

// ── path-segment guard (shared by the daemon + pipeline) ───────────────────
/** One safe path SEGMENT (a course slug). Rejects traversal, separators and
 *  anything that could re-open a path once joined onto a directory. Callers
 *  decodeURIComponent() first, so an encoded separator (%2f/%5c/%2e) has already
 *  become a literal one and is rejected here. Returns null → HTTP 400. */
export const SAFE_SLUG_RE = /^[\w .\-()]+$/;
export function safeSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 200) return null;
  if (s === "." || s === "..") return null;
  if (s.includes("/") || s.includes("\\") || s.includes("%") || s.includes("\0")) return null;
  if (!SAFE_SLUG_RE.test(s)) return null;
  return s;
}
