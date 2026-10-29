/** Proxy: extracted text of a material (document bundle) for the previewer. */
import { NextResponse } from "next/server";
import { daemonUserHeaders, requireUser, unauthorized } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!(await requireUser())) return unauthorized();
  const path = new URL(req.url).searchParams.get("path") ?? "";
  const page = new URL(req.url).searchParams.get("page");
  const q = new URLSearchParams({ path });
  if (page) q.set("page", page);
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/courses/${encodeURIComponent(slug)}/doc?${q}`, { headers: await daemonUserHeaders() });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
