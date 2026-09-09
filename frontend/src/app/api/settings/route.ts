/** Proxy to the daemon's settings (settings.json on the data volume). */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function GET() {
  try {
    const res = await fetch(`${BASE}/settings`, { signal: AbortSignal.timeout(3000) });
    return NextResponse.json(await res.json());
  } catch {
    // full shape so the panel renders sensibly while offline
    return NextResponse.json({ transcribe: true, recordRetentionDays: 30, batchSegments: 4,
      transcribeBatch: 9, geminiModels: "", joinEarlyMinutes: 3, offline: true });
  }
}

export async function PUT(req: Request) {
  try {
    const res = await fetch(`${BASE}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await req.json()),
      signal: AbortSignal.timeout(3000),
    });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
