/** Proxy: save AI output (chat answer, …) as a course material (.md under
 *  Generated/) — POST { name, markdown }. */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";
export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(`${BASE}/courses/${encodeURIComponent(slug)}/materials/generated`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
      body: await req.text(),
      signal: AbortSignal.timeout(30_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
