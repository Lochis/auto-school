/** Proxy: extracted text of a material (document bundle) for the previewer. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const path = new URL(req.url).searchParams.get("path") ?? "";
  const page = new URL(req.url).searchParams.get("page");
  const q = new URLSearchParams({ path });
  if (page) q.set("page", page);
  try {
    const res = await fetch(`${BASE}/courses/${encodeURIComponent(slug)}/doc?${q}`);
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
