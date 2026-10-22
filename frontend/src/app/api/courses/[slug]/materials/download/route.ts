/** Proxy: stream material downloads (single file, or a zip of the selection)
 *  from the backend — never buffers the body. */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ps = new URL(req.url).searchParams.getAll("p");
  if (!ps.length) return NextResponse.json({ error: "p required" }, { status: 400 });
  const qs = ps.map((p) => `p=${encodeURIComponent(p)}`).join("&");
  try {
    // abort deadline covers CONNECT/HEADERS only — a body-spanning timeout
    // would kill large zip streams mid-flight (review 2026-10-21)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(`${await daemonBaseOrThrow()}/courses/${encodeURIComponent(slug)}/materials/download?${qs}`, { headers: await daemonUserHeaders(), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) return NextResponse.json({ error: `backend ${res.status}` }, { status: res.status });
    return new NextResponse(res.body, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
        ...(res.headers.get("content-disposition") ? { "Content-Disposition": res.headers.get("content-disposition")! } : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
