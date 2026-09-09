/** Proxy: ingest a Teams recording + optional transcript into a course folder. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function POST(req: Request) {
  try {
    // stream the multipart body through UNTOUCHED — buffering it via
    // arrayBuffer() OOMs the 512Mi frontend container on lecture-sized videos
    const res = await fetch(`${BASE}/ingest`, {
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
