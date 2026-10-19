import { getAuthUser, trustAuthentikHeaders } from "@/lib/auth";
import { avatarEpoch } from "@/lib/avatar";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAuthUser();
  // Avatar state is upload-or-FaceHash (Gap 4 rework, 2026-10-18): no provider
  // sync exists. This only resolves identity (idempotent claim/JIT, the one
  // write — at most once per user ever) and picks up the write-timestamp for
  // the ?v= cache-buster. Failure → plain /api/me/avatar → FaceHash identicon.
  const v = user ? await avatarEpoch(user) : null;
  const out = user ? { ...user, avatarUrl: `/api/me/avatar${v ? `?v=${v}` : ""}` } : user;
  return NextResponse.json({
    authenticated: user !== null,
    headerTrustEnabled: trustAuthentikHeaders(),
    user: out,
  });
}
