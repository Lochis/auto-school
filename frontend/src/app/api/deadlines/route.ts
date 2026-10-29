/** Deadlines API — GET list, POST rebuild (LLM sweep, slow) or a trivial
 *  mutation, DELETE clear.
 *
 *  Trivial mutations (toggle done, manual due/startBy + revert, delete, fold /
 *  unfold / decline-fold, user note) are pure row edits: in dbReads mode they
 *  run on the platform PG via the shared src/db/deadlines.ts implementation.
 *  Anything else (rebuild = LLM sweep + mtime manifest, unclassifiable kinds)
 *  still proxies to the daemon, which owns the model (unknown bodies become a
 *  rebuild there — the daemon does not 400 them). */
import { NextResponse } from "next/server";
import { dbReads, daemonBaseOrThrow } from "@/lib/backend";
import * as db from "@/lib/db";
import { daemonUserHeaders, ownerId, SYSTEM_OWNER } from "@/lib/owner";
import { applyDeadlineMutation, writeDl } from "../../../../../src/db/deadlines.ts";

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
  const raw = await req.json().catch(() => ({}));
  const prompt: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (dbReads()) {
    const r = await applyDeadlineMutation(prompt, (await ownerId()) ?? SYSTEM_OWNER);
    if (r.ok) {
      // daemon parity: { ok, deadlines, folded?, deleted? } — the panel only
      // reads `deadlines`, so the extra keys are additive (never invented).
      return NextResponse.json({
        ok: true,
        deadlines: r.deadlines,
        ...(r.folded !== undefined ? { folded: r.folded } : {}),
        ...(r.deleted !== undefined ? { deleted: r.deleted } : {}),
      });
    }
    if (r.code !== "unsupported") return NextResponse.json({ error: r.error }, { status: r.status });
    // rebuild / unknown kind → let the daemon handle it (unknown bodies become a rebuild)
  }
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
  if (dbReads()) {
    // clear-all = replace with empty list; daemon returns { ok: true }
    await writeDl([], (await ownerId()) ?? SYSTEM_OWNER);
    return NextResponse.json({ ok: true });
  }
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/deadlines`, { method: "DELETE", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
