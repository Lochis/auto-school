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
    const res = await fetch(base(slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: await req.text(), signal: AbortSignal.timeout(600_000) }); // tool loop + docx→PDF + VLM pages = minutes
    // happy path: SSE stream (tool statuses + live answer tokens) — pass the
    // body through untouched so chunks reach the client as they arrive
    if (res.ok && res.body) {
      return new Response(res.body, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
      });
    }
    // error path (or empty body): plain JSON passthrough
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch { return NextResponse.json({ error: "backend unreachable" }, { status: 502 }); }
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try { return NextResponse.json(await (await fetch(base(slug), { method: "DELETE" })).json()); }
  catch { return NextResponse.json({ error: "backend unreachable" }, { status: 502 }); }
}
