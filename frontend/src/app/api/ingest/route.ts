/** Proxy: ingest a Teams recording + optional transcript into a course folder. */
import { NextResponse } from "next/server";
import { daemonUserHeaders, requireUser, unauthorized } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await requireUser())) return unauthorized(); // interactive UI upload, not a token hop
  try {
    // stream the multipart body through UNTOUCHED — buffering it via
    // arrayBuffer() OOMs the 512Mi frontend container on lecture-sized videos
    const res = await fetch(`${await daemonBaseOrThrow()}/ingest`, {
      method: "POST",
      headers: { "Content-Type": req.headers.get("Content-Type") ?? "", ...(await daemonUserHeaders()) },
      body: req.body,
      duplex: "half",
      signal: AbortSignal.timeout(10 * 60_000),
    } as RequestInit);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
