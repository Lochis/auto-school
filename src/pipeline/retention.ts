/** Recording retention — delete old video, keep transcripts/notes forever.
 *
 * Sweeps:
 *   recordings/  → only *.mp4 / *.mkv / *.webm older than the cutoff
 *   segments/    → everything older than the cutoff (intermediates)
 * `notes/` (notes, __transcript.md, __timeline.json) is NEVER touched.
 *
 * Cadence: called by the daemon at startup (after orphan rescue) and every
 * 6h. Configured via settings.json `recordRetentionDays` (0 = keep forever).
 */
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RECORDINGS_DIR, SEGMENTS_DIR } from "../paths.ts";
import { getSettings } from "../status.ts";

const VIDEO_EXTS = [".mp4", ".mkv", ".webm"];

export function runRetention(now = Date.now()): { removed: number; freedBytes: number } | null {
  const days = getSettings().recordRetentionDays;
  if (!days || days <= 0) return null;
  const cutoff = now - days * 86_400_000;

  let removed = 0;
  let freedBytes = 0;
  const sweep = (dir: string, exts?: string[]): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) { sweep(f, exts); continue; }
      if (exts && !exts.some((x) => e.name.endsWith(x))) continue;
      try {
        const st = statSync(f);
        // mtime: fresh files (live recording / in-flight consolidation) are never past the cutoff
        if (st.mtimeMs < cutoff) { unlinkSync(f); removed++; freedBytes += st.size; }
      } catch { /* raced — ignore */ }
    }
  };

  sweep(RECORDINGS_DIR, VIDEO_EXTS);
  sweep(SEGMENTS_DIR);
  return { removed, freedBytes };
}
