import { getAuthUser } from "@/lib/auth";
import {
  AVATAR_MIME_ALLOWLIST,
  MAX_AVATAR_BYTES,
  clearAvatar,
  ensureUserRow,
  getAvatarFor,
  upsertAvatar,
} from "@/lib/avatar";
import { facehashSvg } from "@/lib/facehash";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Unauthenticated / no edge trust → indistinguishable from "no such route". */
const notFound = () => new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });

/** Same hardening on every 200 this route emits (stored blob or FaceHash
 *  SVG — both may be SVG, so the CSP + nosniff stay on both paths). */
const serveHeaders = (contentType: string, etag: string) => ({
  "content-type": contentType,
  "cache-control": "private, max-age=604800", // 7d, aligned with sync interval
  etag,
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", // SVG hardening
});

/** Serve the DB-cached avatar; when none is stored (never synced, missing
 *  claim, or reset), fall back to the FaceHash identicon — deterministic
 *  per uid, so it caches as safely as a stored avatar (Gap 4b). 404 (no-store)
 *  only for unauthenticated / no-uid / no-trust. */
export async function GET() {
  if (process.env.TRUST_AUTHENTIK_HEADERS !== "1") return notFound();
  const uid = (await headers()).get("x-authentik-uid");
  if (!uid) return notFound();
  try {
    let av: Awaited<ReturnType<typeof getAvatarFor>> = null;
    try {
      av = await getAvatarFor(uid);
    } catch {
      // DB down — FaceHash below; still a 200, no provider dependency.
    }
    if (av && av.bytes.length) {
      return new NextResponse(new Uint8Array(av.bytes), {
        headers: serveHeaders(av.mime, `"${uid}-${av.bytes.length}"`),
      });
    }
    return new NextResponse(facehashSvg(uid), {
      headers: serveHeaders("image/svg+xml", `"fh-${uid}"`),
    });
  } catch {
    return notFound();
  }
}

/** Upload a user avatar: multipart file field, 256KB cap (checked on the
 *  declared size and again on the decoded bytes) and the mime allowlist.
 *  The upload is the ONLY way bytes enter users.avatar (no provider sync,
 *  Gap 4 rework 2026-10-18). Returns the new cache-buster epoch. */
export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return notFound(); // untrusted edge / not behind the outpost
    const form = await request.formData();
    const file = form.getAll("file").find((v): v is File => v instanceof File);
    if (!file) {
      return NextResponse.json({ ok: false, error: "no file field" }, { status: 400 });
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return NextResponse.json({ ok: false, error: "avatar exceeds 256KB" }, { status: 413 });
    }
    if (!AVATAR_MIME_ALLOWLIST.includes(file.type)) {
      return NextResponse.json({ ok: false, error: `unsupported type: ${file.type || "unknown"}` }, { status: 415 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_AVATAR_BYTES) {
      return NextResponse.json({ ok: false, error: "avatar exceeds 256KB" }, { status: 413 });
    }
    const id = await ensureUserRow(user);
    if (!id) return notFound();
    const syncedAt = await upsertAvatar(id, bytes, file.type);
    return NextResponse.json({ ok: true, v: syncedAt?.getTime() ?? Date.now() });
  } catch (e) {
    console.error("[avatar] upload failed:", e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

/** Remove the uploaded avatar: nulls the blob so /api/me/avatar falls back
 *  to the FaceHash identicon (there is no provider avatar to revert to —
 *  Gap 4 rework, 2026-10-18). Bumps synced_at for a fresh ?v=. */
export async function DELETE() {
  try {
    const user = await getAuthUser();
    if (!user) return notFound(); // untrusted edge / not behind the outpost
    const id = await ensureUserRow(user);
    if (!id) return notFound();
    await clearAvatar(id);
    return NextResponse.json({ ok: true, v: Date.now() });
  } catch (e) {
    console.error("[avatar] remove failed:", e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
