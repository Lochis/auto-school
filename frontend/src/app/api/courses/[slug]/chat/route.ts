/** Proxy: course chat with GLM (study assistant scoped to one course). */
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";
const base = (slug: string) => `${BASE}/courses/${encodeURIComponent(slug)}/chat`;
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try { return NextResponse.json(await (await fetch(base(slug), { signal: AbortSignal.timeout(5000) })).json()); }
  catch { return NextResponse.json({ messages: [] }); }
}
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(base(slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: await req.text(), signal: AbortSignal.timeout(30_000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch { return NextResponse.json({ error: "backend unreachable" }, { status: 502 }); }
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try { return NextResponse.json(await (await fetch(base(slug), { method: "DELETE" })).json()); }
  catch { return NextResponse.json({ error: "backend unreachable" }, { status: 502 }); }
}
