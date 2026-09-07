/** Mapping manager API — READS from the shared /data mount (read-only here),
 *  WRITES via the backend controller (it owns /data read-write).
 *  GET  → { mapping, folders, candidates }
 *  POST → { title, folder } upsert (creates the folder)
 *  DELETE ?title= → remove one mapping */
import { NextResponse } from "next/server";
import { candidateTitles, folders, readMapping } from "@/lib/mapping";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function GET() {
  const mapping = readMapping();
  return NextResponse.json({ mapping, folders: folders(), candidates: candidateTitles(mapping) });
}

export async function POST(req: Request) {
  const { title, folder } = (await req.json().catch(() => ({}))) as { title?: string; folder?: string };
  try {
    const res = await fetch(`${BASE}/mapping`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, folder }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json().catch(() => ({ error: "empty response" }));
    if (!res.ok) return NextResponse.json(body, { status: res.status });
    return NextResponse.json({ ...body, folders: folders(), candidates: candidateTitles(body.mapping) });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const title = new URL(req.url).searchParams.get("title");
  try {
    const res = await fetch(`${BASE}/mapping?title=${encodeURIComponent(title ?? "")}`, { method: "DELETE", signal: AbortSignal.timeout(5000) });
    const body = await res.json().catch(() => ({ error: "empty response" }));
    if (!res.ok) return NextResponse.json(body, { status: res.status });
    return NextResponse.json({ ...body, folders: folders(), candidates: candidateTitles(body.mapping) });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
