import { getAuthUser, trustAuthentikHeaders } from "@/lib/auth";
import { syncAvatarIfNeeded } from "@/lib/avatar";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAuthUser();
  // Lazy avatar sync (Gap 4): DB is source of truth; the JWT picture claim
  // only feeds the sync. Never runs inside getAuthUser(). Failures degrade
  // to initials (avatarUrl stays undefined).
  const syncedAt = user ? await syncAvatarIfNeeded(user) : null;
  const out = user ? { ...user, avatarUrl: syncedAt ? `/api/me/avatar?v=${syncedAt.getTime()}` : undefined } : user;
  return NextResponse.json({
    authenticated: user !== null,
    headerTrustEnabled: trustAuthentikHeaders(),
    user: out,
  });
}
