/** Platform notes generation (5b-2 C, D4) — the final-notes pass, on demand.
 *
 *  POST { course, stem, timeline?, meeting? } → resolve the session target from
 *  PG (`resolveSessionTarget`), read the session's stored `timeline` artifact
 *  when the body carries none, then run the shared generator
 *  `finalizeNotes` (src/db/gen/notes.ts) over the running summary + timeline.
 *  Writes the `notes` (and refreshed `timeline`) artifacts and the
 *  transcript_segments rows — all owner-scoped.
 *
 *  Deliberately NOT under /api/ingest: ingestion stays fast + fail-soft
 *  (ingestion-api.md §2 — an LLM sweep can take minutes and must never sit on
 *  the recorder's submit path). This is an interactive platform action, so it
 *  is authenticated like every other read/write route (Authentik headers →
 *  ownerId()), not with INGEST_TOKEN. */
import { NextResponse } from "next/server";
import { ownerId, SYSTEM_OWNER } from "@/lib/owner";
import { getPool } from "../../../../../../src/db/pg.ts";
import { ownerALS } from "../../../../../../src/db/owner.ts";
import { defaultTextCall, finalizeNotes, resolveSessionTarget, type NotesTimelineEntry } from "../../../../../../src/db/gen/notes.ts";

export const dynamic = "force-dynamic";

/** Same stem alphabet the daemon/ingest accept (`YYYY-MM-DD__course__HHMMSS`). */
const STEM_RE = /^[\w\-.\s:]+$/;

/** "m:ss" (or a bare number/string) → seconds — pipeline/segment.ts:26-34 `noteT`. */
function noteSec(t: unknown): number {
  if (typeof t === "number") return Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0;
  const m = String(t ?? "").match(/^(\d{1,3}):(\d{1,2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = parseInt(String(t ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Coerce a body `timeline` into `NotesTimelineEntry[]`; malformed entries are
 *  dropped rather than rejected. Null → the caller falls back to PG. */
function bodyTimeline(raw: unknown): NotesTimelineEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: NotesTimelineEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    const off = Number(e.offsetSec);
    if (!Number.isFinite(off) || off < 0) continue;
    out.push({
      offsetSec: Math.round(off),
      file: typeof e.file === "string" ? e.file : null,
      transcript: typeof e.transcript === "string" ? e.transcript : "",
      visualNotes: Array.isArray(e.visualNotes)
        ? e.visualNotes
            .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
            .map((v) => ({ t: noteSec(v.t), note: typeof v.note === "string" ? v.note : "" }))
        : [],
    });
  }
  return out;
}

/** The session row the route was pointed at (owner-scoped), plus its newest
 *  `timeline` artifact content — one query each, both optional. */
async function sessionLookup(course: string, stem: string, owner: string): Promise<{ title: string | null; timeline: NotesTimelineEntry[] | null }> {
  const s = await getPool().query<{ title: string | null }>(
    `select s.title
       from sessions s
       join courses c on c.id = s.course_id
      where c.slug = $1 and s.stem = $2 and s.owner_user_id = $3
      limit 1`,
    [course, stem, owner],
  );
  const a = await getPool().query<{ content: string | null }>(
    `select sa.content
       from session_artifacts sa
       join sessions s on s.id = sa.session_id
       join courses c on c.id = s.course_id
      where c.slug = $1 and s.stem = $2 and s.owner_user_id = $3
        and sa.kind = 'timeline' and sa.deleted_at is null
      order by sa.updated_at desc
      limit 1`,
    [course, stem, owner],
  );
  let timeline: NotesTimelineEntry[] | null = null;
  const content = a.rows[0]?.content;
  if (typeof content === "string" && content) {
    try { timeline = bodyTimeline(JSON.parse(content)); } catch { timeline = null; }
  }
  return { title: s.rows[0]?.title?.trim() || null, timeline };
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}));
  const body: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const course = typeof body.course === "string" ? body.course.trim() : "";
  const stem = typeof body.stem === "string" ? body.stem.trim() : "";
  if (!course) return NextResponse.json({ error: "course required" }, { status: 400 });
  if (!stem || stem.length > 200 || !STEM_RE.test(stem)) {
    return NextResponse.json({ error: "bad stem" }, { status: 400 });
  }

  const owner = (await ownerId()) ?? SYSTEM_OWNER;
  try {
    // explicit target: slug+stem come from the request, never re-derived from
    // "today" (a re-generate must land on the session the user clicked).
    const target = await resolveSessionTarget(course, { slug: course, stem });

    const supplied = bodyTimeline(body.timeline);
    let timeline = supplied && supplied.length ? supplied : null;
    let title: string | null = null;
    if (!timeline) {
      const found = await sessionLookup(course, stem, owner);
      title = found.title;
      timeline = found.timeline;
    }
    if (!timeline || !timeline.length) {
      return NextResponse.json(
        { error: "no timeline for this session (send `timeline` or ingest one first)" },
        { status: 404 },
      );
    }
    // const: the callback below closes over it (a `let` loses the narrowing)
    const entries = timeline;

    // the meeting title only shapes the prompts (the target is explicit)
    const meeting =
      (typeof body.meeting === "string" && body.meeting.trim()) ||
      (typeof body.name === "string" && body.name.trim()) ||
      title ||
      stem;

    // ownerALS: finalizeNotes resolves the session id via curOwner() (and
    // creates it owner-scoped) — outside the ALS that would be the system user.
    await ownerALS.run(owner, () =>
      finalizeNotes(meeting, entries, {
        target,
        callText: defaultTextCall, // env → app_settings keys, never the fs
        onFinalized: () => { /* no fs tail on the platform (no rebuildIndex/notify) */ },
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api/notes/generate] failed:", String(e).slice(0, 200));
    return NextResponse.json({ error: `notes generation failed: ${String(e).slice(0, 150)}` }, { status: 500 });
  }
}
