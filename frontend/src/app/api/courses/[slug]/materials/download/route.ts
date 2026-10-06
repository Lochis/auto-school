/** Proxy: stream material downloads (single file, or a zip of the selection)
 *  from the backend — never buffers the body. */
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ps = new URL(req.url).searchParams.getAll("p");
  if (!ps.length) return NextResponse.json({ error: "p required" }, { status: 400 });
  const qs = ps.map((p) => `p=${encodeURIComponent(p)}`).join("&");
  try {
    const res = await fetch(`${BASE}/courses/${encodeURIComponent(slug)}/materials/download?${qs}`, { signal: AbortSignal.timeout(10 * 60_000) });
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
