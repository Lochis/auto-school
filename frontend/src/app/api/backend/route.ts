/** Proxy to the backend daemon's controller (same pod → 127.0.0.1).
 *  GET → /status   (may answer {online:false} if the daemon is down/restarting)
 *  POST → /scan    body {reset?, leave?, join?, authGraph?, paused?} — rescan now;
 *                 reset re-attends same-titled meetings (test workflow);
 *                 authGraph starts the one-time Graph device-code approval;
 *                 paused toggles auto-join suppression (absence mode). */
import { NextResponse } from "next/server";
import { courses, sessions as dataSessions } from "@/lib/data";

export const dynamic = "force-dynamic";

const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

/** The daemon's course strings (and mp4 path prefixes) don't always match
 *  the folder names under the data root that the frontend's /course/<slug>
 *  routes resolve. Canonicalize against the real data dir so UI links from
 *  daemon data can never point at a non-existent course route. */
const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]/g, "");

function canonicalizeSession(s: Record<string, unknown>, canon: Map<string, string>): void {
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
    if (file && hit && dataSessions(hit).some((x) => x.stem === file)) s.sessionStem = file;
    else if (typeof s.stem === "string" && /^\d{4}-\d{2}-\d{2}__/.test(s.stem) && hit && dataSessions(hit).some((x) => x.stem === s.stem)) s.sessionStem = s.stem;
  }
}

export async function GET() {
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    if (body?.sessions && Array.isArray(body.sessions) && body.sessions.length) {
      const canon = new Map<string, string>();
      for (const c of courses()) canon.set(norm(c), c);
      for (const s of body.sessions as Record<string, unknown>[]) canonicalizeSession(s, canon);
    }
    return NextResponse.json(body);
  } catch {
    return NextResponse.json({ online: false, state: "offline" });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { reset?: boolean; leave?: boolean; join?: string; authGraph?: boolean; paused?: boolean };
  try {
    if (typeof body.paused === "boolean") {
      const res = await fetch(`${BASE}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: body.paused }),
        signal: AbortSignal.timeout(3000),
      });
      return NextResponse.json(await res.json());
    }
    if (body.authGraph) {
      const res = await fetch(`${BASE}/auth/graph`, { method: "POST", signal: AbortSignal.timeout(3000) });
      return NextResponse.json(await res.json(), { status: res.status });
    }
    if (body.leave) {
      const res = await fetch(`${BASE}/leave`, { method: "POST", signal: AbortSignal.timeout(3000) });
      return NextResponse.json(await res.json());
    }
    if (body.join) {
      const res = await fetch(`${BASE}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: body.join }),
        signal: AbortSignal.timeout(5000),
      });
      return NextResponse.json(await res.json(), { status: res.status });
    }
    const res = await fetch(`${BASE}/scan${body.reset ? "?reset=1" : ""}`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ online: false, error: "backend unreachable" }, { status: 502 });
  }
}
