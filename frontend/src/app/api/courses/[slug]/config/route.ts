/** Proxy: course config (semesterStart) — anchors week derivation. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(`${BASE}/courses/${encodeURIComponent(slug)}/config`, { signal: AbortSignal.timeout(5000) });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ semesterStart: "" });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(`${BASE}/courses/${encodeURIComponent(slug)}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
