import { getAuthUser, trustAuthentikHeaders } from "@/lib/auth";
import { avatarEpoch } from "@/lib/avatar";
import { resolveRecorder } from "@/lib/backend";
import { requireUser, unauthorized } from "@/lib/owner";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAuthUser();
  // Fail closed (security-hardening.md §1): no resolvable owner → 401. The
  // identity probe is a user-facing route like any other; a direct pod hit
  // (headers stripped by middleware.ts) must not learn anything either.
  const owner = await requireUser();
  if (!owner) return unauthorized();
  // Avatar state is upload-or-FaceHash (Gap 4 rework, 2026-10-18): no provider
  // sync exists. This only resolves identity (idempotent claim/JIT, the one
  // write — at most once per user ever) and picks up the write-timestamp for
  // the ?v= cache-buster. Failure → plain /api/me/avatar → FaceHash identicon.
  const v = user ? await avatarEpoch(user) : null;
  const out = user ? { ...user, avatarUrl: `/api/me/avatar${v ? `?v=${v}` : ""}` } : user;
  // Recorder attachment (recorder-split.md §4): attached = a fresh registry
  // endpoint OR the transitional BACKEND_URL fallback resolved for this owner.
  const rec = await resolveRecorder(owner);
  return NextResponse.json({
    authenticated: user !== null,
    headerTrustEnabled: trustAuthentikHeaders(),
    user: out,
    recorder: { attached: rec.base !== null, mode: rec.mode },
  });
}
