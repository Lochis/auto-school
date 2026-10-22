/** Proxy: course config (semesterStart) — anchors week derivation. */
import { NextResponse } from "next/server";
import { daemonUserHeaders } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/courses/${encodeURIComponent(slug)}/config`, { headers: await daemonUserHeaders(), signal: AbortSignal.timeout(5000) });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ semesterStart: "" });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/courses/${encodeURIComponent(slug)}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
      body: await req.text(),
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
