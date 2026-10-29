/** Checklists API — GET list, POST generate/toggle/add/remove (generation is a
 *  slow LLM sweep over course documents), DELETE clear one/all.
 *
 *  PLATFORM_AI=1 (platform manifest, 5b-2 A1): checklist GENERATION runs HERE
 *  via the shared src/db/gen/checklist.ts generator over PG documents (the
 *  daemon runs the same generator over the fs corpus). Unset → daemon proxy,
 *  unchanged. */
import { NextResponse } from "next/server";
import { dbReads, daemonBaseOrThrow } from "@/lib/backend";
import * as db from "@/lib/db";
import { daemonUserHeaders, ownerId, SYSTEM_OWNER } from "@/lib/owner";
import { applyChecklistMutation, readCk, readDl, writeCk } from "../../../../../src/db/deadlines.ts";
import { generateChecklist, ChecklistGenError } from "../../../../../src/db/gen/checklist.ts";
import { ownerALS } from "../../../../../src/db/owner.ts";

export const dynamic = "force-dynamic";
/** Platform-side generation switch (manifest env, added in 5b-2 A1). */
const platformAi = (): boolean => process.env.PLATFORM_AI === "1";

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
  // a generate body carries ONLY deadlineId (no item toggle / add / remove)
  const isGenerate = typeof mut.deadlineId === "string" && mut.itemId === undefined && mut.add === undefined && mut.removeItemId === undefined;
  if (dbReads()) {
    // item toggle / manual add / item remove run on the platform PG; checklist
    // GENERATION needs the LLM + course tools — locally when PLATFORM_AI=1,
    // else it falls through to the daemon.
    const owner = (await ownerId()) ?? SYSTEM_OWNER;
    const r = await applyChecklistMutation(mut, owner);
    if (r.ok) return NextResponse.json({ ok: true, checklists: r.checklists });
    if (r.code !== "unsupported") return NextResponse.json({ error: r.error }, { status: r.status });
    if (platformAi() && isGenerate) {
      const dlId = String(mut.deadlineId);
      // same lookup + 404 as the daemon's generate branch
      const dl = (await readDl(owner)).find((d) => d.id === dlId);
      if (!dl) return NextResponse.json({ error: "no such deadline id" }, { status: 404 });
      try {
        // ownerALS: the generator's db/* helpers read curOwner() for the
        // corpus probe and the checklist_items carry-over
        const gen = await ownerALS.run(owner, () => generateChecklist(dl, dl.course, {
          owner,
          onEvent: () => { /* no board feed on the platform */ },
        }));
        return NextResponse.json({ ok: true, count: gen.items.length, checklists: gen.checklists });
      } catch (e) {
        // generation failures keep their exact pre-5b2c bodies (no JSON array /
        // JSON parse failed / no usable steps)
        if (e instanceof ChecklistGenError) return NextResponse.json({ error: e.message }, { status: e.status });
        console.error("[api/checklists] generation failed:", String(e).slice(0, 200));
        return NextResponse.json({ error: `checklist failed: ${String(e).slice(0, 150)}` }, { status: 500 });
      }
    }
  }
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
