import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getAvatarFor } from "@/lib/avatar";

export const dynamic = "force-dynamic";

export async function GET() {
  const notFound = () => new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  if (process.env.TRUST_AUTHENTIK_HEADERS !== "1") return notFound();
  const uid = (await headers()).get("x-authentik-uid");
  if (!uid) return notFound();
  try {
    const av = await getAvatarFor(uid);
    if (!av || !av.bytes.length) return notFound();
    return new NextResponse(new Uint8Array(av.bytes), {
      headers: {
        "content-type": av.mime,
        "cache-control": "private, max-age=604800",          // 7d, aligned with sync interval
        etag: `"${uid}-${av.bytes.length}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", // SVG hardening
      },
    });
  } catch { return notFound(); }
}
