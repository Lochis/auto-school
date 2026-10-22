/** Proxy: delete an entire course folder (backend refuses if sessions exist). */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/courses/${encodeURIComponent(slug)}`, { method: "DELETE", headers: await daemonUserHeaders() });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
