/**
 * Edge-trust hardening (Phase 0/1): strip spoofed X-authentik-* identity
 * headers from requests that did NOT come through the Traefik edge.
 *
 * PREMISE (fixed, 2026-10-29 security review): it is NOT true that only the
 * /api/me* routes read X-authentik-* — materials upload/download, ingest,
 * media streams and every daemon-proxy route do. So the strip runs for ALL
 * routes: there is no identity-bearing handler that can be reached with
 * client-supplied headers.
 *
 * Trust mechanism (one atomic chain — security-hardening.md §3):
 *  - EDGE_SECRET is REQUIRED in the platform manifest (from the
 *    auto-school-env Secret; a missing key keeps the pod from starting).
 *  - deploy/k8s/authentik-edge.yaml defines the `auto-school-edge-marker`
 *    middleware, which stamps X-Edge-Secret: <same secret>. It is chained in
 *    deploy/k8s/auto-school-ingress.yaml AFTER `authentik-forwardauth` on the
 *    catch-all Host rule — so only requests that actually passed the
 *    authentik outpost get the marker. Traefik cannot read the value from a
 *    Secret, so the Middleware is rendered from it at apply time (command in
 *    that file); an unrendered marker fails closed: every request is
 *    stripped → requireUser() 401s.
 *  - Requests without a matching marker (kubectl port-forward, direct pod
 *    access, spoofed client headers) have X-authentik-*, X-Auto-School-User
 *    and X-Internal-Auth removed before any handler sees them.
 *
 * EDGE_SECRET unset (local `next dev`, docker-compose) → pass through; there
 * is no edge to be trusted, and lib/auth.ts requires
 * TRUST_AUTHENTIK_HEADERS=1 (never set locally) to honor headers at all.
 *
 * Body-size note: legitimate edge traffic takes the plain NextResponse.next()
 * path (marker present, nothing rewritten), so request bodies — including the
 * streaming materials/ingest uploads — are never touched. Only the strip path
 * rebuilds the header set, and stripping never happens for a >10MB upload
 * that came through the edge.
 */
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const secret = process.env.EDGE_SECRET;
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
  // Every application route is covered (no api exclusions — see the premise in
  // the file header: materials/ingest DO consume identity). Static assets are
  // the only skip: they carry no identity and are served without a handler.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
