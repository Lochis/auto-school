/** Proxy: purge a session (mp4 + notes + timeline) on the backend. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function DELETE(req: Request) {
  const q = new URL(req.url).searchParams;
  const course = q.get("course"), stem = q.get("stem");
  if (!course || !stem) return NextResponse.json({ error: "course and stem required" }, { status: 400 });
  try {
    const res = await fetch(`${BASE}/session?course=${encodeURIComponent(course)}&stem=${encodeURIComponent(stem)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
