import { getAuthUser, trustAuthentikHeaders } from "@/lib/auth";
import { NextResponse } from "next/server";

/** Who am I, per the Authentik edge headers? Primary Phase 0 verification
 *  endpoint: `curl https://school.vanderloch.com/api/me` after login.
 *  Returns 200 + { authenticated: false } when header trust is off (local
 *  dev) or the request didn't come through the outpost. */
export async function GET() {
  const user = await getAuthUser();
  return NextResponse.json({
    authenticated: user !== null,
    headerTrustEnabled: trustAuthentikHeaders(),
    user,
  });
}
