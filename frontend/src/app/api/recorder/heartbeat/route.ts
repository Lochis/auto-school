/** Recorder heartbeat (recorder-split.md §3): the personal daemon POSTs here
 *  every 30s with its owner + capabilities so the platform can resolve the
 *  owner's recorder endpoint from the registry. Bearer-token auth (v1):
 *  Authorization: Bearer $RECORDER_TOKEN, constant-time compared. */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getUserIdBySub } from "../../../../../../src/db/avatar.ts";
import { upsertRecorderHeartbeat } from "../../../../../../src/db/recorders.ts";

export const dynamic = "force-dynamic";

function tokenOk(header: string | null): boolean {
  const expected = process.env.RECORDER_TOKEN;
  if (!expected) return false;
  const got = (header ?? "").replace(/^Bearer\s+/i, "");
  // sha256 digests equalize length for a constant-time compare.
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const authz = req.headers.get("authorization");
  if (!tokenOk(authz)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    owner?: string;
    name?: string;
    mode?: "inbound" | "poll";
    endpoint?: string;
    capabilities?: Record<string, unknown>;
  };

  if (typeof body.owner !== "string" || !body.owner) {
    return NextResponse.json({ error: "owner required" }, { status: 400 });
  }

  try {
    const ownerUserId = await getUserIdBySub(body.owner);
    if (!ownerUserId) {
      // Unknown uid — never fabricate a row for a stranger's recorder.
      return NextResponse.json({ error: "unknown owner" }, { status: 401 });
    }
    await upsertRecorderHeartbeat({
      ownerUserId,
      name: typeof body.name === "string" && body.name ? body.name : "personal",
      mode: body.mode === "poll" ? "poll" : "inbound",
      endpoint: typeof body.endpoint === "string" ? body.endpoint : null,
      capabilities:
        body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {},
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[heartbeat] failed:", String(e).slice(0, 200));
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
