/**
 * Edge-trust hardening (Phase 0/1): strip spoofed X-authentik-* identity
 * headers from requests that did NOT come through the Traefik edge.
 *
 * PREMISE (fixed, 2026-10-29 security review): it is NOT true that only the
 * /api/me* routes read X-authentik-* — materials upload/download, ingest,
 * media streams and every daemon-proxy route do. So the strip runs for every
 * route in the matcher, minus the body-streaming uploads (see the matcher
 * note below).
 *
 * Trust mechanism (one atomic chain — security-hardening.md §3):
 *  - EDGE_MARKER is REQUIRED in the platform manifest (from the
 *    auto-school-env Secret; a missing key keeps the pod from starting).
 *  - deploy/k8s/authentik-edge.yaml defines the `auto-school-edge-marker`
 *    middleware, which stamps X-Edge-Secret: <same secret>. It is chained in
 *    deploy/k8s/auto-school-ingress.yaml AFTER `authentik-forwardauth` on the
 *    catch-all Host rule — so only requests that actually passed the
 *    authentik outpost get the marker. Traefik cannot read the value from a
 *    Secret, so the Middleware is rendered from it at apply time (command in
 *    that file); an unrendered marker fails closed: every request is
 *    stripped AND getAuthUser() rejects it → requireUser() 401s.
 *  - Requests without a matching marker (kubectl port-forward, direct pod
 *    access, spoofed client headers) have X-authentik-*, X-Auto-School-User
 *    and X-Internal-Auth removed before any handler sees them.
 *
 * THIS MIDDLEWARE IS DEFENSE-IN-DEPTH, NOT THE ENFORCEMENT POINT (fix wave
 * E). The real gate is lib/auth.ts getAuthUser(): it requires
 * X-Edge-Secret === EDGE_MARKER in the NODE runtime (headers only, no body)
 * and returns null otherwise, so a route that never saw this middleware still
 * cannot be spoofed.
 *
 * Body-size note (why two route families are excluded): the Next edge
 * runtime unconditionally clones+buffers the body of every non-GET/HEAD
 * request routed through middleware and silently truncates it at the 10MB
 * default (`middlewareClientMaxBodySize`). `/api/ingest` (lecture recordings)
 * and `/api/courses/<slug>/materials` (slide decks) stream bodies far larger
 * than that, so they MUST stay out of the matcher — they are protected by
 * getAuthUser()'s marker check instead. Raising the limit is not an option:
 * it buffers whole uploads in RAM next to the streaming proxies.
 *
 * EDGE_MARKER unset (local `next dev`, docker-compose) → pass through; there
 * is no edge to be trusted, and lib/auth.ts requires
 * TRUST_AUTHENTIK_HEADERS=1 (never set locally) to honor headers at all.
 */
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const secret = process.env.EDGE_MARKER;
  if (!secret) return NextResponse.next();
  if (req.headers.get("x-edge-secret") === secret) return NextResponse.next();

  let stripped = false;
  const h = new Headers(req.headers);
  for (const key of [...h.keys()]) {
    if (
      /^x-authentik/i.test(key) ||
      /^x-auto-school-user/i.test(key) ||
      /^x-internal-auth/i.test(key)
    ) {
      h.delete(key);
      stripped = true;
    }
  }
  if (!stripped) return NextResponse.next();
  return NextResponse.next({ request: { headers: h } });
}

export const config = {
  // CAUTION: keep the streaming upload proxies OUT of the matcher. Next's
  // edge runtime clones+buffers every non-GET body routed through middleware
  // and caps it at 10MB (`middlewareClientMaxBodySize`) — a lecture-sized
  // video or slide deck was silently truncated to its first 10MB (the daemon
  // then answered "file and course required"). Those two routes trust the
  // X-Edge-Secret marker directly in lib/auth.ts getAuthUser() (node runtime,
  // headers only), so they are covered without buffering a byte. Static
  // assets carry no identity and are served without a handler.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/ingest|api/courses/[^/]+/materials).*)",
  ],
};
