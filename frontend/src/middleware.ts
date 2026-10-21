/**
 * Edge-trust hardening (Phase 0): strip spoofed X-authentik-* identity headers
 * from requests that did NOT pass through the Traefik edge middleware.
 *
 * The Traefik forwardAuth middleware with authResponseHeadersRegex already
 * removes client-supplied X-authentik-* on the edge path. This covers the
 * remaining path: requests hitting the pod directly (kubectl port-forward,
 * localhost debugging in k8s) while TRUST_AUTHENTIK_HEADERS=1 is set.
 *
 * Wire-up (see deploy/k8s/authentik-edge.yaml):
 *  - EDGE_SECRET set (frontend env, from the auto-school-env Secret) AND
 *  - a Traefik `headers` middleware sets X-Edge-Secret to the same value,
 *    chained before the app service in the IngressRoute.
 *
 * If EDGE_SECRET is unset this middleware passes everything through and the
 * env flag in src/lib/auth.ts is the only gate (fine for local dev).
 */
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const secret = process.env.EDGE_SECRET;
  if (!secret) return NextResponse.next();
  if (req.headers.get("x-edge-secret") === secret) return NextResponse.next();

  let stripped = false;
  const h = new Headers(req.headers);
  for (const key of [...h.keys()]) {
    if (/^x-authentik/i.test(key) || /^x-auto-school-user/i.test(key)) {
      h.delete(key);
      stripped = true;
    }
  }
  if (!stripped) return NextResponse.next();
  return NextResponse.next({ request: { headers: h } });
}

export const config = {
  // CAUTION: keep the streaming upload proxies OUT of the matcher. Next 15.5
  // buffers every request body routed through middleware and caps it at 10MB
  // (middlewareClientMaxBodySize) — a lecture-sized video got silently
  // truncated to its first 10MB and the daemon answered "file and course
  // required". Safe to skip here: neither route reads X-authentik-* headers
  // (only /api/me* do), so there is nothing to strip.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/ingest|api/courses/[^/]+/materials).*)",
  ],
};
