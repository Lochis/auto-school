/** Lexicon — leaf filename → { course, path } across all materials
 *  (powers the linkifier + previewer in the all-courses chat). */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/chat/lexicon`, { headers: await daemonUserHeaders(), signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({}, { status: 502 });
  }
}
