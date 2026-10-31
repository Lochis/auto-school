/** Ingestion API v1 (ingestion-api.md §2): the Electron client submits a
 *  finished session's derived *text* (transcript / notes / timeline). No raw
 *  video here — video sync is storage-backends §4.
 *
 *  Auth (per-user-ingest-tokens.md §3): resolution order in POST —
 *  1. A per-user bearer (`asi_…`, stored sha256-hashed in ingest_tokens)
 *     that resolves to an active token → the OWNER COMES FROM THE TOKEN.
 *     `body.owner`, if still sent, must resolve to the same users.id — a
 *     mismatch is 401 (defensive: catches misconfigured clients).
 *  2. No per-user match → the legacy GLOBAL shared secret path: Bearer
 *     $INGEST_TOKEN, constant-time compared (same pattern as
 *     /api/recorder/heartbeat — sha256 both sides, timingSafeEqual), bound
 *     hard to the SEED system owner (fix wave D,
 *     docs/planning/security-hardening.md P3) via `body.owner`. Unset env
 *     fails closed (401).
 *  3. Neither → 401 { ok:false, error:"unauthorized" } — one shape for
 *     unknown/revoked/expired, no state oracle.
 *
 *  Writes go through src/db/writes.ts so the natural-key upserts keep
 *  resubmissions idempotent (session: course_id+stem+owner, artifact:
 *  session_id+kind+rel_path → update, never duplicate). */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getUserIdBySub } from "../../../../../../src/db/avatar.ts";
import { resolveIngestToken } from "../../../../../../src/db/ingest-tokens.ts";
import { SYSTEM_OWNER } from "@/lib/owner";
import { listSessions } from "../../../../../../src/db/queries/sessions.ts";
import { courseId, sessionId, upsertArtifact, upsertSegments, type SegmentInit } from "../../../../../../src/db/writes.ts";
import { ownerALS } from "../../../../../../src/db/owner.ts";
import { embedPendingSessions } from "../../../../../../src/db/embed-sessions.ts";
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

/** Timeline entries → writable `transcript_segments` rows.
 *  Entries without a finite non-negative `offsetSec` are skipped; `visualNotes`
 *  are coerced to `{t: seconds, note}` (pipeline/segment.ts `noteT`). */
function toSegments(timeline: unknown): SegmentInit[] {
  if (!Array.isArray(timeline)) return [];
  // one row per offset_sec: a duplicate inside one INSERT trips the
  // (session_id, offset_sec) ON CONFLICT target ("cannot affect row a second
  // time"). Last entry wins, matching the upsert's own update semantics.
  const byOffset = new Map<number, SegmentInit>();
  for (const raw of timeline) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    const off = Number(e.offsetSec);
    if (!Number.isFinite(off) || off < 0) continue;
    const offsetSec = Math.round(off);
    const notes = Array.isArray(e.visualNotes)
      ? e.visualNotes
          .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
          .map((v) => ({ t: noteSec(v.t), note: typeof v.note === "string" ? v.note : "" }))
      : [];
    byOffset.set(offsetSec, {
      segIndex: 0, // renumbered below (map insertion order = timeline order)
      offsetSec,
      file: typeof e.file === "string" ? e.file : null,
      transcript: typeof e.transcript === "string" ? e.transcript : "",
      visualNotes: notes,
    });
  }
  return [...byOffset.values()].map((s, i) => ({ ...s, segIndex: i }));
}

/** "m:ss" (or a bare number/string) → seconds — pipeline/segment.ts:26-34 `noteT`. */
function noteSec(t: unknown): number {
  if (typeof t === "number") return Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0;
  const m = String(t ?? "").match(/^(\d{1,3}):(\d{1,2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = parseInt(String(t ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
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
    const authHeader = req.headers.get("authorization");
    const bearer = (authHeader ?? "").replace(/^Bearer\s+/i, "");
    // Resolution order (per-user-ingest-tokens.md §3): per-user token first,
    // then the legacy shared secret — both before body parsing so an
    // unauthenticated request never spends the 8 MiB read.
    const tokenHit = bearer ? await resolveIngestToken(bearer) : null;
    if (!tokenHit && !tokenOk(authHeader)) {
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
    let ownerUserId: string;
    if (tokenHit) {
      // Per-user token: the owner comes from the TOKEN (hosted users can
      // ingest as themselves — no SYSTEM_OWNER bind here). Defensive
      // cross-check: a body.owner still sent by the client must resolve to
      // the token's own owner, else the client's idea of itself diverged
      // from its credential — 401 instead of a silently misattributed write.
      if (typeof body.owner === "string" && body.owner) {
        const bodyOwner = await getUserIdBySub(body.owner);
        if (bodyOwner !== tokenHit.ownerUserId) {
          return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
      }
      ownerUserId = tokenHit.ownerUserId;
    } else {
      // Legacy shared-secret path (wave-D bind, unchanged): the GLOBAL
      // INGEST_TOKEN may only write as the seed system owner. Resolve the
      // authentik uid → users.id and require equality — an unknown uid or
      // any other real user is 401, never "whatever id the body said".
      if (typeof body.owner !== "string" || !body.owner) {
        return NextResponse.json({ ok: false, error: "owner required" }, { status: 400 });
      }
      const resolved = await getUserIdBySub(body.owner);
      if (!resolved || resolved !== SYSTEM_OWNER) {
        return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      ownerUserId = resolved;
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
    // §1.3 ingest delta: the timeline is not only an artifact blob — it is also
    // materialized into transcript_segments so the embed sweep can see it.
    // Built before any write so a malformed entry is dropped, never thrown.
    const segments = toSegments(timeline);
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

    // Owner resolved above (token owner, or the wave-D-bound seed owner).
    // Every downstream write keys on ownerUserId: listSessions/ownerALS.run

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
        // transcript_segments — idempotent on (session_id, offset_sec); own
        // try/catch: segment materialization must never fail the ingest.
        if (segments.length) {
          try {
            await upsertSegments(id, segments);
          } catch (e) {
            console.error("[ingest/session] segment materialization failed:", String(e).slice(0, 200));
          }
        }
      }
      return id;
    });

    // Make the ingested text semantically searchable without waiting for the
    // daemon's 6h sweep (the daemon need not be running when a client posts
    // here). Fire-and-forget: an embedding/API-key failure must never fail an
    // ingest that already committed. No owner param needed: the sweep derives
    // each documents row's owner from its SESSION row (s.owner_user_id), so it
    // stays correctly attributed even outside ownerALS.run.
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
