/** Ingestion API v1 (ingestion-api.md §2): the Electron client submits a
 *  finished session's derived *text* (transcript / notes / timeline). No raw
 *  video here — video sync is storage-backends §4.
 *
 *  Auth: Authorization: Bearer $INGEST_TOKEN, constant-time compared (same
 *  pattern as /api/recorder/heartbeat — sha256 both sides, timingSafeEqual).
 *  Unset env fails closed (401).
 *
 *  Writes go through src/db/writes.ts so the natural-key upserts keep
 *  resubmissions idempotent (session: course_id+stem+owner, artifact:
 *  session_id+kind+rel_path → update, never duplicate). */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getUserIdBySub } from "../../../../../../src/db/avatar.ts";
import { listSessions } from "../../../../../../src/db/queries/sessions.ts";
import { courseId, sessionId, upsertArtifact } from "../../../../../../src/db/writes.ts";
import { ownerALS } from "../../../../../../src/db/owner.ts";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** mirrors the daemon's accepted stem alphabet (`YYYY-MM-DD__course__HHMMSS`) */
const STEM_RE = /^[\w\-.\s:]+$/;

function tokenOk(header: string | null): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return false; // fail closed — no token configured, no ingest
  const got = (header ?? "").replace(/^Bearer\s+/i, "");
  // sha256 digests equalize length for a constant-time compare.
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Today in UTC (daemon /ingest default: `new Date().toISOString().slice(0,10)`). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** HHMMSS as an integer, Toronto-local — exactly the daemon's ingest seq. */
function torontoSeq(): number {
  const hhmmss = new Date()
    .toLocaleTimeString("en-CA", { hour12: false, timeZone: "America/Toronto" })
    .replace(/:/g, "");
  const n = Number(hhmmss);
  return Number.isFinite(n) ? n : 0;
}

/** Daemon ingest stem: `${date}__${course}__${HHMMSS padded to 6}`. */
function deriveStem(course: string, date: string): string {
  return `${date}__${course}__${String(torontoSeq()).padStart(6, "0")}`;
}

export async function POST(req: Request) {
  try {
    if (!tokenOk(req.headers.get("authorization"))) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      owner?: unknown;
      course?: unknown;
      name?: unknown;
      date?: unknown;
      stem?: unknown;
      transcript?: unknown;
      notes?: unknown;
      timeline?: unknown;
    } | null;

    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "json body required" }, { status: 400 });
    }
    if (typeof body.owner !== "string" || !body.owner) {
      return NextResponse.json({ ok: false, error: "owner required" }, { status: 400 });
    }

    // course slug — same sanitizer as the daemon /ingest handler.
    const course =
      typeof body.course === "string"
        ? body.course.replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_")
        : "";
    if (!course) {
      return NextResponse.json({ ok: false, error: "course required" }, { status: 400 });
    }

    const date =
      typeof body.date === "string" && DATE_RE.test(body.date) ? body.date : today();

    // optional display name — daemon's sanitizer (no path chars / controls).
    const name =
      typeof body.name === "string"
        ? body.name.replace(/[\\/\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80)
        : "";

    let stem: string | null = null;
    if (body.stem !== undefined && body.stem !== null && body.stem !== "") {
      if (typeof body.stem !== "string" || body.stem.length > 200 || !STEM_RE.test(body.stem)) {
        return NextResponse.json({ ok: false, error: "invalid stem" }, { status: 400 });
      }
      stem = body.stem;
    }

    const transcript = typeof body.transcript === "string" ? body.transcript : null;
    const notes = typeof body.notes === "string" ? body.notes : null;
    const timeline = body.timeline === undefined || body.timeline === null ? null : body.timeline;
    if (transcript === null && notes === null && timeline === null) {
      return NextResponse.json(
        { ok: false, error: "at least one of transcript/notes/timeline required" },
        { status: 400 },
      );
    }

    // Resolve the authentik uid → users.id; never fabricate a row for a stranger.
    const ownerUserId = await getUserIdBySub(body.owner);
    if (!ownerUserId) {
      return NextResponse.json({ ok: false, error: "unknown owner" }, { status: 401 });
    }

    if (!stem) {
      // No explicit stem: resubmitting the same day's derived text must update,
      // not duplicate. Reuse the newest same-day *ingest-created* session
      // (no recording artifact — recorded sessions are never hijacked), else
      // mint a daemon-style stem.
      const prefix = `${date}__${course}__`;
      const existing = (await listSessions(course, ownerUserId)).find(
        (s) => !s.audio && s.stem.startsWith(prefix),
      );
      stem = existing?.stem ?? deriveStem(course, date);
    }
    const finalStem = stem;

    // Every write runs inside the request's owner context: writes.ts keys
    // sessions by curOwner() (= owner_user_id), and outside an ALS store that
    // falls back to the SYSTEM owner — which would file this session under
    // lochis and make the same-day reuse lookup above miss (duplicates).
    const sid = await ownerALS.run(ownerUserId, async () => {
      const cid = await courseId(course);
      const id = await sessionId(cid, finalStem, {
        sessionDate: date,
        ...(name ? { title: name } : {}),
      });

      if (transcript !== null) {
        await upsertArtifact(id, "transcript", `notes/${course}/${finalStem}__transcript.md`, {
          content: transcript,
          mimeType: "text/markdown",
        });
      }
      if (notes !== null) {
        await upsertArtifact(id, "notes", `notes/${course}/${finalStem}__notes.md`, {
          content: notes,
          mimeType: "text/markdown",
        });
      }
      if (timeline !== null) {
        await upsertArtifact(id, "timeline", `notes/${course}/${finalStem}__timeline.json`, {
          content: JSON.stringify(timeline, null, 2),
          mimeType: "application/json",
        });
      }
      return id;
    });

    return NextResponse.json({ ok: true, sessionId: sid, stem: finalStem });
  } catch (e) {
    console.error("[ingest/session] failed:", String(e).slice(0, 200));
    return NextResponse.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }
}
