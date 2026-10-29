/** Checklists API — GET list, POST generate/toggle/add/remove (generation is a
 *  slow LLM sweep over course documents), DELETE clear one/all. */
import { NextResponse } from "next/server";
import { dbReads, daemonBaseOrThrow } from "@/lib/backend";
import * as db from "@/lib/db";
import { daemonUserHeaders, ownerId, SYSTEM_OWNER } from "@/lib/owner";
import { applyChecklistMutation, readCk, writeCk } from "../../../../../src/db/deadlines.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  if (dbReads()) return NextResponse.json({ checklists: await db.checklists(await ownerId()) });
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/checklists`, { headers: await daemonUserHeaders(), signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const mut: Record<string, unknown> = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (dbReads()) {
    // item toggle / manual add / item remove run on the platform PG; checklist
    // GENERATION needs the LLM + course tools, so it falls through to the daemon.
    const r = await applyChecklistMutation(mut, (await ownerId()) ?? SYSTEM_OWNER);
    if (r.ok) return NextResponse.json({ ok: true, checklists: r.checklists });
    if (r.code !== "unsupported") return NextResponse.json({ error: r.error }, { status: r.status });
  }
  const isGenerate = typeof mut.deadlineId === "string" && mut.itemId === undefined && mut.add === undefined && mut.removeItemId === undefined;
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/checklists`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(isGenerate ? 600_000 : 15_000), // generation reads real documents — minutes
    });
    const json = await res.json().catch(() => ({ error: "empty response" }));
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable (or timed out)" }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("deadlineId");
  if (dbReads()) {
    const owner = (await ownerId()) ?? SYSTEM_OWNER;
    if (id) {
      const ck = (await readCk(owner)).filter((c) => c.deadlineId !== id);
      await writeCk(ck, owner);
      return NextResponse.json({ ok: true, checklists: ck });
    }
    await writeCk([], owner);
    return NextResponse.json({ ok: true });
  }
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/checklists${id ? `?deadlineId=${encodeURIComponent(id)}` : ""}`, { method: "DELETE", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => ({}));
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
