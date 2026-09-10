/** Rename a course — backend moves folders + updates meeting mappings. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { to } = (await req.json().catch(() => ({}))) as { to?: string };
  try {
    const res = await fetch(`${BASE}/courses/${encodeURIComponent(slug)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({ error: "empty response" }));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
