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
import { embedPendingSessions } from "../../../../../../src/db/ingest-embed.ts";
import { upsertIngestDeadlines, type IngestDeadline } from "../../../../../../src/db/deadlines.ts";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** mirrors the daemon's accepted stem alphabet (`YYYY-MM-DD__course__HHMMSS`) */
const STEM_RE = /^[\w\-.\s:]+$/;
/** Request-body ceiling. Derived text for one class is a few hundred KB at
 *  most (transcript + notes + timeline); 8 MiB is generous, and anything
 *  larger is refused before JSON.parse so a bad/looping client cannot pin the
 *  single pod's heap. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Stages that mean a capture is in flight for that stem. The recording
 *  artifact is only written at consolidation, so such a row has no `audio`
 *  and would otherwise look "ingest-created" to the same-day stem reuse
 *  lookup — an ingest during a live class would adopt the recording's stem. */
const IN_FLIGHT_STAGES = new Set(["recording", "remuxing", "transcribing", "noting", "consolidating"]);

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

/** Parse the JSON body under MAX_BODY_BYTES. Null → 400 (missing/malformed);
 *  the TOO_LARGE sentinel → 413. */
const TOO_LARGE = Symbol("body-too-large");
async function readJsonBody(req: Request): Promise<unknown | null | typeof TOO_LARGE> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return TOO_LARGE;
  const raw = await req.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return TOO_LARGE; // chunked / understated content-length
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    if (!tokenOk(req.headers.get("authorization"))) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const rawBody = await readJsonBody(req);
    if (rawBody === TOO_LARGE) {
      return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
    }
    const body = rawBody as {
      owner?: unknown;
      course?: unknown;
      name?: unknown;
      date?: unknown;
      stem?: unknown;
      transcript?: unknown;
      notes?: unknown;
      timeline?: unknown;
      deadlines?: unknown;
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
    // Optional deadline batch (ingestion-api.md §2): the client may submit the
    // calendar items it extracted. Applied AFTER the session/artifacts commit,
    // with per-item skips (non-objects, missing course/title) — never a 400.
    const deadlines: IngestDeadline[] = Array.isArray(body.deadlines)
      ? body.deadlines
          .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
          .map((d) => ({
            title: typeof d.title === "string" ? d.title : "",
            course: typeof d.course === "string" ? d.course : course,
            ...("due" in d ? { due: d.due === null ? null : String(d.due) } : {}),
            ...("startBy" in d ? { startBy: d.startBy === null ? null : String(d.startBy) } : {}),
          }))
      : [];
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
      // (no recording artifact AND no in-flight stage — a live recording only
      // gets its artifact at consolidation, so `!s.audio` alone would adopt
      // its stem), else mint a daemon-style stem.
      const prefix = `${date}__${course}__`;
      const existing = (await listSessions(course, ownerUserId)).find(
        (s) => !s.audio && !IN_FLIGHT_STAGES.has(s.stage ?? "") && s.stem.startsWith(prefix),
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
        // ingested text is a finished session, not a capture: without this the
        // writes.ts default 'recording' left the row mid-flight, and the
        // daemon's boot heal (pipeline/sessions.ts hydrateSessions) then failed
        // it as "interrupted by restart".
        stage: "done",
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

    // Make the ingested text semantically searchable without waiting for the
    // daemon's 6h sweep (the daemon need not be running when a client posts
    // here). Fire-and-forget: an embedding/API-key failure must never fail an
    // ingest that already committed.
    void embedPendingSessions().catch(() => { });

    // Deadline batch — its OWN try/catch: the session + artifacts are already
    // committed, so a bad batch must never roll that back or turn into a 500.
    let dlSummary: { upserted: number; added: number; updated: number; skipped: number } | undefined;
    if (body.deadlines !== undefined) {
      try {
        const r = await upsertIngestDeadlines(ownerUserId, deadlines);
        dlSummary = { upserted: r.upserted, added: r.added, updated: r.updated, skipped: r.skipped };
        if (r.error) console.error("[ingest/session] deadline batch rolled back:", r.error);
      } catch (e) {
        dlSummary = { upserted: 0, added: 0, updated: 0, skipped: deadlines.length };
        console.error("[ingest/session] deadline batch failed:", String(e).slice(0, 200));
      }
    }

    return NextResponse.json({ ok: true, sessionId: sid, stem: finalStem, ...(dlSummary ? { deadlines: dlSummary } : {}) });
  } catch (e) {
    console.error("[ingest/session] failed:", String(e).slice(0, 200));
    return NextResponse.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }
}
