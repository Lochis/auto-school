/** Proxy manual transcription to the daemon. */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const qs = new URL(req.url).search;
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/transcribe${qs}`, { method: "POST", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(5000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
