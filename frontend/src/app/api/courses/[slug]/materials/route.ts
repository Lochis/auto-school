/** Proxy: course materials (upload, list, delete) + course config on the backend. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

const base = (slug: string) => `${BASE}/courses/${encodeURIComponent(slug)}/materials`;

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(base(slug), { signal: AbortSignal.timeout(5000) });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    // stream the multipart through untouched (no RAM buffering)
    const res = await fetch(base(slug), {
      method: "POST",
      headers: { "Content-Type": req.headers.get("Content-Type") ?? "" },
      body: req.body,
      duplex: "half",
      signal: AbortSignal.timeout(10 * 60_000),
    } as RequestInit);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const q = new URL(req.url).searchParams;
  const file = q.get("file"), week = q.get("week");
  if (!file || !week) return NextResponse.json({ error: "file and week required" }, { status: 400 });
  try {
    const res = await fetch(`${base(slug)}?file=${encodeURIComponent(file)}&week=${encodeURIComponent(week)}`, { method: "DELETE", signal: AbortSignal.timeout(5000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
