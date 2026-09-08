/** Proxy: ingest a Teams recording + optional transcript into a course folder. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function POST(req: Request) {
  try {
    // large videos: generous timeout, stream the multipart through untouched
    const res = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { "Content-Type": req.headers.get("Content-Type") ?? "" },
      body: await req.arrayBuffer(),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
