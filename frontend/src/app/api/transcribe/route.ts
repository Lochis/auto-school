/** Proxy manual transcription to the daemon. */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function POST(req: Request) {
  const qs = new URL(req.url).search;
  try {
    const res = await fetch(`${BASE}/transcribe${qs}`, { method: "POST", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(5000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
