/** Proxy to the daemon's model quotas endpoint. */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/models`, { headers: await daemonUserHeaders(), signal: AbortSignal.timeout(3000) });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json([]);
  }
}
