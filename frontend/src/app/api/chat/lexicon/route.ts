/** Lexicon — leaf filename → { course, path } across all materials
 *  (powers the linkifier + previewer in the all-courses chat). */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function GET() {
  try {
    const res = await fetch(`${BASE}/chat/lexicon`, { signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({}, { status: 502 });
  }
}
