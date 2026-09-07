/** Proxy to the backend daemon's controller (same pod → 127.0.0.1).
 *  GET → /status   (may answer {online:false} if the daemon is down/restarting)
 *  POST → /scan    body {reset?, leave?, join?, authGraph?} — rescan now;
 *                 reset re-attends same-titled meetings (test workflow);
 *                 authGraph starts the one-time Graph device-code approval. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function GET() {
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(3000) });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ online: false, state: "offline" });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { reset?: boolean; leave?: boolean; join?: string; authGraph?: boolean };
  try {
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
