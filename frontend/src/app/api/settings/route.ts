/** Proxy to the daemon's settings (settings.json on the data volume). */
import { NextResponse } from "next/server";
import { daemonUserHeaders, requireUser, unauthorized } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await requireUser())) return unauthorized();
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/settings`, { headers: await daemonUserHeaders(), signal: AbortSignal.timeout(3000) });
    return NextResponse.json(await res.json());
  } catch {
    // full shape so the panel renders sensibly while offline
    return NextResponse.json({ transcribe: true, recordRetentionDays: 30, batchSegments: 4,
      transcribeBatch: 9, geminiModels: "", joinEarlyMinutes: 3, offline: true });
  }
}

export async function PUT(req: Request) {
  if (!(await requireUser())) return unauthorized();
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
      body: JSON.stringify(await req.json()),
      signal: AbortSignal.timeout(3000),
    });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
