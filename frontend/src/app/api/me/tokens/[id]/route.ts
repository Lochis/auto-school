/** Revoke one of the caller's ingest tokens (per-user-ingest-tokens.md §2).
 *  Owner scoping lives in the SQL (revokeIngestToken), so another user's id
 *  is indistinguishable from a nonexistent one → the same 404. */
import { NextResponse } from "next/server";
import { revokeIngestToken } from "../../../../../../../src/db/ingest-tokens.ts";
import { requireUser, unauthorized } from "@/lib/owner";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await requireUser();
  if (!owner) return unauthorized();
  const { id } = await params;
  const n = await revokeIngestToken(owner, id);
  if (n === 0) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
