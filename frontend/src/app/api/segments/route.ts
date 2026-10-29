/** Proxy: purge ALL raw segments (test/ops). Recordings/notes stay. */
import { NextResponse } from "next/server";
import { daemonUserHeaders, requireUser, unauthorized } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function DELETE() {
  if (!(await requireUser())) return unauthorized();
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/segments`, { method: "DELETE", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(10_000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
