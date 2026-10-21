/** Proxy: purge ALL raw segments (test/ops). Recordings/notes stay. */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function DELETE() {
  try {
    const res = await fetch(`${BASE}/segments`, { method: "DELETE", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(10_000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
