/** Mapping manager API — reads go through lib/backend mappingSnap() (fs, or
 *  PG when configured), WRITES via the backend controller (it owns the data
 *  root + Postgres).
 *  GET  → { mapping, folders, candidates }
 *  POST → { title, folder } upsert (creates the folder)
 *  DELETE ?title= → remove one mapping */
import { NextResponse } from "next/server";
import { mappingSnap, daemonBaseOrThrow, OwnerRequiredError } from "@/lib/backend";
import { daemonUserHeaders, requireUser, unauthorized } from "@/lib/owner";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await requireUser())) return unauthorized();
  try {
    return NextResponse.json(await mappingSnap());
  } catch (e) {
    // DB mode with no resolvable owner (PG died mid-request): 401, never the
    // seed owner's mapping (fail-closed requireOwner, security fix wave E)
    if (e instanceof OwnerRequiredError) return unauthorized();
    throw e;
  }
}

export async function POST(req: Request) {
  const { title, folder } = (await req.json().catch(() => ({}))) as { title?: string; folder?: string };
  if (!(await requireUser())) return unauthorized();
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/mapping`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(await daemonUserHeaders()) },
      body: JSON.stringify({ title, folder }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json().catch(() => ({ error: "empty response" }));
    if (!res.ok) return NextResponse.json(body, { status: res.status });
    // branch the read-shape the same way GET does (fs vs PG) — the daemon
    // writes Postgres, so an fs-built response would echo stale folders here
    const snap = await mappingSnap();
    return NextResponse.json({ ...body, folders: snap.folders, candidates: snap.candidates });
  } catch (e) {
    if (e instanceof OwnerRequiredError) return unauthorized();
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const title = new URL(req.url).searchParams.get("title");
  if (!(await requireUser())) return unauthorized();
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/mapping?title=${encodeURIComponent(title ?? "")}`, { method: "DELETE", headers: await daemonUserHeaders(), signal: AbortSignal.timeout(5000) });
    const body = await res.json().catch(() => ({ error: "empty response" }));
    if (!res.ok) return NextResponse.json(body, { status: res.status });
    const snap = await mappingSnap();
    return NextResponse.json({ ...body, folders: snap.folders, candidates: snap.candidates });
  } catch (e) {
    if (e instanceof OwnerRequiredError) return unauthorized();
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
