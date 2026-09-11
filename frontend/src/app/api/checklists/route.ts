/** Checklists API — GET list, POST generate/toggle/add/remove (generation is a
 *  slow LLM sweep over course documents), DELETE clear one/all. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function GET() {
  try {
    const res = await fetch(`${BASE}/checklists`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const isGenerate = typeof body.deadlineId === "string" && body.itemId === undefined && body.add === undefined && body.removeItemId === undefined;
  try {
    const res = await fetch(`${BASE}/checklists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(isGenerate ? 600_000 : 15_000), // generation reads real documents — minutes
    });
    const json = await res.json().catch(() => ({ error: "empty response" }));
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable (or timed out)" }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("deadlineId");
  try {
    const res = await fetch(`${BASE}/checklists${id ? `?deadlineId=${encodeURIComponent(id)}` : ""}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => ({}));
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
