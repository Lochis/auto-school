/** Create a course shell — for courses the bot can't join yet: upload
 *  materials + ingest recordings/transcripts by hand. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function POST(req: Request) {
  const { slug, semesterStart } = (await req.json().catch(() => ({}))) as { slug?: string; semesterStart?: string };
  try {
    const res = await fetch(`${BASE}/courses/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, semesterStart }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({ error: "empty response" }));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
