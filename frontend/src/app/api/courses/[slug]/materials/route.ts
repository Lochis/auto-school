/** Proxy: course materials (upload, rename/move, delete) on the backend. */
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";
const base = (slug: string) => `${BASE}/courses/${encodeURIComponent(slug)}/materials`;

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(base(slug), { signal: AbortSignal.timeout(5000) });
    return NextResponse.json(await res.json());
  } catch { return NextResponse.json({ materials: [] }); }
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(base(slug), {
      method: "POST",
      headers: { "Content-Type": req.headers.get("Content-Type") ?? "" },
      body: req.body, duplex: "half",
      signal: AbortSignal.timeout(10 * 60_000),
    } as RequestInit);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch { return NextResponse.json({ error: "backend unreachable" }, { status: 502 }); }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(base(slug), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch { return NextResponse.json({ error: "backend unreachable" }, { status: 502 }); }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const path = new URL(req.url).searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  try {
    const res = await fetch(`${base(slug)}?path=${encodeURIComponent(path)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch { return NextResponse.json({ error: "backend unreachable" }, { status: 502 }); }
}
