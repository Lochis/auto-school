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
