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
import { join, relative } from "node:path";
import { RECORDINGS_DIR, SEGMENTS_DIR, DATA_DIR } from "../paths.ts";
import { getSettings } from "../status.ts";
import { getPool } from "../db/client.ts";
import { pgConfigured } from "../db/reader.ts";

const VIDEO_EXTS = [".mp4", ".mkv", ".webm"];

/** DB-authoritative retention schedule: when a recording artifact is written,
 *  its retained_until is now + recordRetentionDays (0/absent = keep forever →
 *  null). The fs sweep below uses the SAME setting (DB-primary via
 *  hydrateSettings), so fs and DB never disagree. */
export function retainedUntilFrom(now = Date.now()): string | null {
  const days = getSettings().recordRetentionDays;
  if (!days || days <= 0) return null;
  return new Date(now + days * 86_400_000).toISOString();
}

/** Mark unlinked recordings in session_artifacts (deleted_at) — the DB row is
 *  the authoritative record of what the schedule removed and when. */
function markDeleted(relPaths: string[]): void {
  if (!relPaths.length || !pgConfigured()) return;
  void getPool()
    .query(
      `update session_artifacts set deleted_at = now(), updated_at = now()
       where kind = 'recording' and deleted_at is null and rel_path = any($1)`,
      [relPaths],
    )
    .catch((e) => console.warn(`[retention] DB deleted_at update failed: ${String(e).slice(0, 120)}`));
}

export function runRetention(now = Date.now()): { removed: number; freedBytes: number } | null {
  const days = getSettings().recordRetentionDays;
  if (!days || days <= 0) return null;
  const cutoff = now - days * 86_400_000;

  let removed = 0;
  let freedBytes = 0;
  const unlinked: string[] = [];
  const sweep = (dir: string, exts?: string[]): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) { sweep(f, exts); continue; }
      if (exts && !exts.some((x) => e.name.endsWith(x))) continue;
      try {
        const st = statSync(f);
        // mtime: fresh files (live recording / in-flight consolidation) are never past the cutoff
        if (st.mtimeMs < cutoff) {
          unlinkSync(f); removed++; freedBytes += st.size;
          if (dir.startsWith(RECORDINGS_DIR))
            unlinked.push(relative(DATA_DIR, f).split(/[\\/]/).join("/"));
        }
      } catch { /* raced — ignore */ }
    }
  };

  sweep(RECORDINGS_DIR, VIDEO_EXTS);
  sweep(SEGMENTS_DIR);
  markDeleted(unlinked);
  return { removed, freedBytes };
}
