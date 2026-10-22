/** Deadlines API — GET list, POST rebuild (LLM sweep, slow), DELETE clear. */
import { NextResponse } from "next/server";
import { dbReads, daemonBaseOrThrow } from "@/lib/backend";
import * as db from "@/lib/db";
import { daemonUserHeaders, ownerId } from "@/lib/owner";

export const dynamic = "force-dynamic";

export async function GET() {
  if (dbReads()) return NextResponse.json(await db.deadlinesFeed(await ownerId()));
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/deadlines`, { headers: await daemonUserHeaders(), signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const prompt = await req.json().catch(() => ({}));
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/deadlines`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
      body: JSON.stringify(prompt ?? {}),
      signal: AbortSignal.timeout(600_000), // the LLM reads real documents — minutes
    });
    const body = await res.json().catch(() => ({ error: "empty response" }));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable (or timed out)" }, { status: 502 });
  }
}

export async function DELETE() {
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/deadlines`, { method: "DELETE", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
