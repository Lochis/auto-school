/** Proxy: study-sheet generator — POST { topic } (new) or { path } (regenerate).
 *  Tool-loop LLM on the backend: reads materials + notes, writes a dense
 *  markdown cheat sheet (+ printable PDF) under Generated/. Slow by design. */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(`${BASE}/courses/${encodeURIComponent(slug)}/study-sheet`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
      body: await req.text(),
      signal: AbortSignal.timeout(550_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable (or timed out — generation can take a few minutes)" }, { status: 502 });
  }
}
