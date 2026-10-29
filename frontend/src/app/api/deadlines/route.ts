/** Deadlines API — GET list, POST rebuild (LLM sweep, slow) or a trivial
 *  mutation, DELETE clear.
 *
 *  Trivial mutations (toggle done, manual due/startBy + revert, delete, fold /
 *  unfold / decline-fold, user note) are pure row edits: in dbReads mode they
 *  run on the platform PG via the shared src/db/deadlines.ts implementation.
 *  Anything else (rebuild = LLM sweep + mtime manifest, unclassifiable kinds)
 *  still proxies to the daemon, which owns the model (unknown bodies become a
 *  rebuild there — the daemon does not 400 them).
 *
 *  PLATFORM_AI=1 (platform manifest, 5b-2 A1): the rebuild runs HERE, on the
 *  platform, over PG documents via the shared src/db/gen/deadlines.ts
 *  generator (same code the daemon runs over the fs corpus). Unset → the
 *  daemon proxy below, unchanged. */
import { NextResponse } from "next/server";
import { dbReads, daemonBaseOrThrow } from "@/lib/backend";
import * as db from "@/lib/db";
import { daemonUserHeaders, ownerId, SYSTEM_OWNER } from "@/lib/owner";
import { applyDeadlineMutation, clearDeadlines } from "../../../../../src/db/deadlines.ts";
import { rebuildDeadlines, DeadlineGenError } from "../../../../../src/db/gen/deadlines.ts";
import { ownerALS } from "../../../../../src/db/owner.ts";

export const dynamic = "force-dynamic";
/** Platform-side generation switch (manifest env, added in 5b-2 A1). */
const platformAi = (): boolean => process.env.PLATFORM_AI === "1";

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
    const owner = (await ownerId()) ?? SYSTEM_OWNER;
    const r = await applyDeadlineMutation(prompt, owner);
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
    // rebuild / unknown kind — on the platform, run the sweep locally (5b-2 C)
    if (platformAi()) {
      try {
        // ownerALS: metaLoad/metaReplace + the db/* helpers key on curOwner()
        const rebuilt = await ownerALS.run(owner, () => rebuildDeadlines({
          mode: prompt.mode === "full" ? "full" : "update",
          owner,
          onEvent: () => { /* no board feed on the platform */ },
        }));
        // daemon parity: the early exit's body is exactly the pre-5b2c one
        // ({ ok, mode:"update", count, added:[], changed:0 }); `deadlines`,
        // `warning` and `coverage` are additive (the panel reads deadlines).
        return NextResponse.json({
          ok: true,
          mode: rebuilt.unchanged ? "update" : rebuilt.mode,
          count: rebuilt.count,
          added: rebuilt.added,
          ...(rebuilt.unchanged
            ? { changed: 0, deadlines: rebuilt.deadlines }
            : {
                updated: rebuilt.updated,
                deduped: rebuilt.deduped,
                folded: rebuilt.folded,
                suggestions: rebuilt.suggestions,
                changed: rebuilt.changed,
                deadlines: rebuilt.deadlines,
              }),
          ...(rebuilt.warning ? { warning: rebuilt.warning } : {}),
          ...(rebuilt.coverage.length ? { coverage: rebuilt.coverage } : {}),
        });
      } catch (e) {
        // in-body failures keep their exact pre-5b2c bodies (no JSON array /
        // JSON parse failed / empty deadline list)
        if (e instanceof DeadlineGenError) return NextResponse.json({ error: e.message }, { status: e.status });
        console.error("[api/deadlines] rebuild failed:", String(e).slice(0, 200));
        return NextResponse.json({ error: `deadline rebuild failed: ${String(e).slice(0, 150)}` }, { status: 500 });
      }
    }
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
    // clear-all = the daemon's raw owner-scoped delete (never writeDl([], …):
    // that preserves accepted fold children, whose parent delete then cascades
    // the fold and resurfaces them — daemon/platform divergence). Returns { ok: true }.
    await clearDeadlines((await ownerId()) ?? SYSTEM_OWNER);
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
