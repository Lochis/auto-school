/** Proxy: course materials (upload, rename/move, delete) on the backend. */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";
export const dynamic = "force-dynamic";
const base = async (slug: string) => `${await daemonBaseOrThrow()}/courses/${encodeURIComponent(slug)}/materials`;

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // forward opt-in flags (?indexed=1 shows the .index/ page cache)
  const q = new URL(req.url).searchParams;
  const flag = q.get("indexed") === "1" ? "?indexed=1" : "";
  try {
    const res = await fetch(await base(slug) + flag, { headers: await daemonUserHeaders(), signal: AbortSignal.timeout(5000) });
    return NextResponse.json(await res.json());
  } catch { return NextResponse.json({ materials: [] }); }
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(await base(slug), {
      method: "POST",
      headers: { "Content-Type": req.headers.get("Content-Type") ?? "", ...(await daemonUserHeaders()) },
      body: req.body, duplex: "half",
      signal: AbortSignal.timeout(10 * 60_000),
    } as RequestInit);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch { return NextResponse.json({ error: "backend unreachable" }, { status: 502 }); }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(await base(slug), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
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
    const res = await fetch(`${await base(slug)}?path=${encodeURIComponent(path)}`, { method: "DELETE", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(10_000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch { return NextResponse.json({ error: "backend unreachable" }, { status: 502 }); }
}
