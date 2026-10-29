/** Proxy: save AI output (chat answer, …) as a course material (.md under
 *  Generated/) — POST { name, markdown }. */
import { NextResponse } from "next/server";
import { daemonUserHeaders, requireUser, unauthorized } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!(await requireUser())) return unauthorized();
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/courses/${encodeURIComponent(slug)}/materials/generated`, {
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
