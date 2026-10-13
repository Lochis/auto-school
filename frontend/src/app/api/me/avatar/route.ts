import { headers } from "next/headers";
import { NextResponse } from "next/server";

/** Serve the Authentik user's avatar to the browser.
 *
 * Authentik's core API requires a token (authentik_core.view_user), so the
 * browser can't fetch it directly — this route proxies it:
 *   X-authentik-uid (edge-injected, trusted) → GET /api/v3/core/users/{uid}/
 *   → avatar field, which is either a data: URI (generated initials SVG) or
 *   an http(s) URL (gravatar / custom attribute). Both are served as an
 *   image with a private 1h cache so page loads don't hammer the API.
 *
 * Env: AUTHENTIK_API_URL (e.g. http://authentik-server.authentik.svc.cluster.local)
 *      AUTHENTIK_API_TOKEN (service token of svc-autoschool-avatar — see
 *      deploy/k8s/auto-school.yaml comments)
 * 404s (img onError → initials/icon fallback) when unauthenticated, unconfigured,
 * or Authentik unreachable — never blocks the UI. */
export async function GET() {
  const notFound = () => new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });

  if (process.env.TRUST_AUTHENTIK_HEADERS !== "1") return notFound();
  const uid = (await headers()).get("x-authentik-uid");
  if (!uid) return notFound();

  const base = process.env.AUTHENTIK_API_URL?.replace(/\/+$/, "");
  const token = process.env.AUTHENTIK_API_TOKEN;
  if (!base || !token) return notFound();

  try {
    const res = await fetch(`${base}/api/v3/core/users/${encodeURIComponent(uid)}/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return notFound();
    const avatar: unknown = (await res.json())?.avatar;
    if (typeof avatar !== "string" || !avatar) return notFound();

    // data URI (authentik's generated initials avatar)
    const m = /^data:(image\/[\w.+-]+);base64,([\s\S]*)$/.exec(avatar);
    if (m) {
      const buf = Buffer.from(m[2], "base64");
      return new NextResponse(new Uint8Array(buf), {
        headers: { "content-type": m[1], "cache-control": "private, max-age=3600" },
      });
    }

    // plain URL (gravatar / custom avatar attribute) — proxy it too, so the
    // browser never talks to third parties directly
    if (/^https?:\/\//i.test(avatar)) {
      const img = await fetch(avatar, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (img.ok && img.body) {
        return new NextResponse(img.body, {
          headers: {
            "content-type": img.headers.get("content-type") ?? "image/png",
            "cache-control": "private, max-age=3600",
          },
        });
      }
    }
    return notFound();
  } catch {
    return notFound();
  }
}
