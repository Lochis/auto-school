/** Phase-3 read queries — course listing + per-course settings.
 *  Postgres replacement for the fs scans in frontend/src/lib/data.ts
 *  (courses() = folder-union under recordings/ + notes/, courseIcon() /
 *  semesterStartOf() = courses/<slug>/course.json). Style: raw template SQL
 *  via the shared Pool, mirroring src/db/writes.ts. */
import { getPool } from "../pg.ts";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await getPool().query(text, params)).rows as T[];

export interface CourseMeta {
  slug: string;
  name: string;
  /** icon key chosen in the course settings modal (course.json "icon") */
  icon: string | null;
  /** semester start "YYYY-MM-DD" (course.json "semesterStart") */
  semesterStart: string | null;
}

/** data.ts courses(): sorted list of course slugs. In the fs layer this is the
 *  union of directories under recordings/ and notes/; in Postgres every such
 *  course self-registered a courses row (importer §2), so a plain slug scan
 *  is the equivalent surface. */
export async function listCourses(): Promise<string[]> {
  const rows = await q<{ slug: string }>(`select slug from courses order by slug`);
  return rows.map((r) => r.slug);
}

/** data.ts courseIcon() + semesterStartOf() in one round-trip (course.json
 *  parity). Null when the course is unknown — same as the fs try/catch. */
export async function courseMeta(slug: string): Promise<CourseMeta | null> {
  const rows = await q<{ slug: string; name: string; icon: string | null; semester_start: string | null }>(
    `select slug, name, icon, semester_start::text as semester_start
     from courses where slug = $1`,
    [slug],
  );
  const r = rows[0];
  return r ? { slug: r.slug, name: r.name, icon: r.icon, semesterStart: r.semester_start } : null;
}
