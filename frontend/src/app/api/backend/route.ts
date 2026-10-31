/** Proxy to the backend daemon's controller (same pod → 127.0.0.1).
 *  GET → /status   (may answer {online:false} if the daemon is down/restarting)
 *  POST → /scan    body {reset?, leave?, join?, authGraph?, paused?} — rescan now;
 *                 reset re-attends same-titled meetings (test workflow);
 *                 authGraph starts the one-time Graph device-code approval;
 *                 paused toggles auto-join suppression (absence mode). */
import { NextResponse } from "next/server";
import { daemonUserHeaders, requireUser, unauthorized } from "@/lib/owner";
import { listCourses, listSessions, daemonBaseOrThrow, OwnerRequiredError } from "@/lib/backend";

export const dynamic = "force-dynamic";


/** The daemon's course strings (and mp4 path prefixes) don't always match
 *  the folder names under the data root that the frontend's /course/<slug>
 *  routes resolve. Canonicalize against the real data dir so UI links from
 *  daemon data can never point at a non-existent course route. */
const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]/g, "");

function canonicalizeSession(s: Record<string, unknown>, canon: Map<string, string>, stemsByCourse: Map<string, Set<string>>): void {
  const cand =
    (typeof s.course === "string" && s.course) ||
    (typeof s.mp4 === "string" && s.mp4.match(/^recordings\/([^/]+)\//)?.[1]) ||
    undefined;
  const hit = cand && canon.get(norm(cand));
  if (hit) s.course = hit;
  else delete s.course; // unresolvable → UI must not link it
  // validate the deep-link stem against the data dir before advertising it
  delete s.sessionStem;
  if (typeof s.mp4 === "string") {
    const file = s.mp4.split("/").pop()?.replace(/\.(mp4|webm)$/, "");
    if (file && hit && stemsByCourse.get(hit)?.has(file)) s.sessionStem = file;
    else if (typeof s.stem === "string" && /^\d{4}-\d{2}-\d{2}__/.test(s.stem) && hit && stemsByCourse.get(hit)?.has(s.stem)) s.sessionStem = s.stem;
  }
}

export async function GET() {
  if (!(await requireUser())) return unauthorized();
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/status`, { headers: await daemonUserHeaders(), signal: AbortSignal.timeout(3000) });
    // The daemon gates /status to the recorder owner (seed) — a non-seed
    // member's signed hop 401s. Translate to a benign offline shape instead of
    // passing the error JSON through (use-status would cache it as status).
    if (!res.ok) return NextResponse.json({ online: false, state: "offline", ...(res.status === 401 ? { restricted: true } : {}) });
    const body = await res.json();
    if (body?.sessions && Array.isArray(body.sessions) && body.sessions.length) {
      const canon = new Map<string, string>();
      const stemsByCourse = new Map<string, Set<string>>();
      for (const c of await listCourses()) {
        canon.set(norm(c), c);
        stemsByCourse.set(c, new Set((await listSessions(c)).map((x) => x.stem)));
      }
      for (const s of body.sessions as Record<string, unknown>[]) canonicalizeSession(s, canon, stemsByCourse);
    }
    return NextResponse.json(body);
  } catch (e) {
    // DB mode with no resolvable owner (PG died mid-request): 401, not the
    // seed owner's catalog (fail-closed requireOwner, wave E)
    if (e instanceof OwnerRequiredError) return unauthorized();
    return NextResponse.json({ online: false, state: "offline" });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { reset?: boolean; leave?: boolean; join?: string; authGraph?: boolean; paused?: boolean };
  if (!(await requireUser())) return unauthorized();
  try {
    if (typeof body.paused === "boolean") {
      const res = await fetch(`${await daemonBaseOrThrow()}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
        body: JSON.stringify({ paused: body.paused }),
        signal: AbortSignal.timeout(3000),
      });
      return NextResponse.json(await res.json());
    }
    if (body.authGraph) {
      const res = await fetch(`${await daemonBaseOrThrow()}/auth/graph`, { method: "POST", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(3000) });
      return NextResponse.json(await res.json(), { status: res.status });
    }
    if (body.leave) {
      const res = await fetch(`${await daemonBaseOrThrow()}/leave`, { method: "POST", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(3000) });
      return NextResponse.json(await res.json());
    }
    if (body.join) {
      const res = await fetch(`${await daemonBaseOrThrow()}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
        body: JSON.stringify({ title: body.join }),
        signal: AbortSignal.timeout(5000),
      });
      return NextResponse.json(await res.json(), { status: res.status });
    }
    const res = await fetch(`${await daemonBaseOrThrow()}/scan${body.reset ? "?reset=1" : ""}`, {
      method: "POST",
      headers: await daemonUserHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ online: false, error: "backend unreachable" }, { status: 502 });
  }
}
