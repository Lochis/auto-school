/** Per-user ingest token management (per-user-ingest-tokens.md §2). All
 *  routes requireUser()-gated (fail-closed, same as /api/me/avatar); the
 *  owner is ALWAYS the session user — never a body param. The raw token
 *  appears in the POST response exactly once and is never stored. */
import { NextResponse } from "next/server";
import {
  createIngestToken,
  listIngestTokens,
} from "../../../../../../src/db/ingest-tokens.ts";
import { requireUser, unauthorized } from "@/lib/owner";

export const dynamic = "force-dynamic";

/** GET → the caller's tokens (metadata only — prefix/label/timestamps,
 *  never the hash). Bare array per the design sketch. */
export async function GET() {
  const owner = await requireUser();
  if (!owner) return unauthorized();
  const tokens = await listIngestTokens(owner);
  return NextResponse.json(
    tokens.map((t) => ({
      id: t.id,
      prefix: t.prefix,
      label: t.label,
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      expiresAt: t.expiresAt?.toISOString() ?? null,
      revokedAt: t.revokedAt?.toISOString() ?? null,
    })),
    { headers: { "cache-control": "no-store" } },
  );
}

/** POST → mint: { label?, expiresAt? (ISO) } ⇒ 201
 *  { id, token, prefix, label } — `token` is the one-time raw credential. */
export async function POST(req: Request) {
  const owner = await requireUser();
  if (!owner) return unauthorized();
  let body: { label?: unknown; expiresAt?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "json body required" }, { status: 400 });
  }
  const label = typeof body.label === "string" ? body.label : "";
  let expiresAt: Date | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== "") {
    const d = new Date(String(body.expiresAt));
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ ok: false, error: "invalid expiresAt" }, { status: 400 });
    }
    expiresAt = d;
  }
  const minted = await createIngestToken(owner, label, expiresAt);
  if (!minted) {
    return NextResponse.json(
      { ok: false, error: "active token cap reached — revoke one first" },
      { status: 400 },
    );
  }
  return NextResponse.json(minted, { status: 201 });
}
