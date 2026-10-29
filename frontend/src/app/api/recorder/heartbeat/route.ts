/** Recorder heartbeat (recorder-split.md §3): the personal daemon POSTs here
 *  every 30s with its owner + capabilities so the platform can resolve the
 *  owner's recorder endpoint from the registry. Bearer-token auth (v1):
 *  Authorization: Bearer $RECORDER_TOKEN, constant-time compared.
 *
 *  Fix wave D (docs/planning/security-hardening.md P3 — heartbeat hardening):
 *  - the body must be COMPLETE (`owner`, `mode`, `endpoint`, `capabilities`) —
 *    the registry row is a resolved proxy target, so a partial body used to be
 *    able to null/replace fields of a live row (endpoint poisoning);
 *  - the endpoint is validated against an SSRF blocklist: a stolen global
 *    RECORDER_TOKEN must not be able to aim this platform's proxy at internal
 *    services (RFC1918, loopback, link-local, cloud metadata, ULA/link-local v6).
 *  Per-user recorder tokens (bound to users.id, the multi-client future) are
 *  the remaining P3 item — see the docs. */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getUserIdBySub } from "../../../../../../src/db/avatar.ts";
import { upsertRecorderHeartbeat } from "../../../../../../src/db/recorders.ts";

export const dynamic = "force-dynamic";

/** `name` is part of the registry primary key (owner_user_id, name) — a long
 *  value is a junk row, not a truncation candidate (silently slicing would
 *  fork a second row under a different key). */
const MAX_NAME = 64;
const MAX_ENDPOINT = 512;
const MAX_CAPABILITIES = 4096;

/** The co-located daemon's port: the transitional same-pod install
 *  (docker-compose / `next dev`, no Authentik edge) registers
 *  `http://localhost:7800` as its recorder endpoint. That ONE loopback target
 *  stays allowed — it only reaches the daemon, which itself 401s any hop
 *  without a valid X-Internal-Auth HMAC (wave B), so it is not an SSRF pivot. */
const CO_LOCATED_PORT = Number(process.env.PORT ?? 7800) || 7800;

function tokenOk(header: string | null): boolean {
  const expected = process.env.RECORDER_TOKEN;
  if (!expected) return false;
  const got = (header ?? "").replace(/^Bearer\s+/i, "");
  // sha256 digests equalize length for a constant-time compare.
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** RFC1918 / loopback / link-local / this-network IPv4 literals, or null when
 *  public (or not an IPv4 literal at all). Prefix-regex rather than octet
 *  parsing so abbreviated forms (`127.1`) are caught too; a DNS name (the k8s
 *  `auto-school-recorder` Service) matches nothing and is allowed — name→IP
 *  resolution (DNS rebinding) is out of scope for v1. */
function blockedV4(host: string): string | null {
  if (/^127\./.test(host)) return "loopback 127.0.0.0/8";
  if (/^0\./.test(host)) return "this-network 0.0.0.0/8";
  if (/^10\./.test(host)) return "private 10.0.0.0/8";
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return "private 172.16.0.0/12";
  if (/^192\.168\./.test(host)) return "private 192.168.0.0/16";
  // 169.254.0.0/16 covers the cloud metadata address 169.254.169.254
  if (/^169\.254\./.test(host)) return "link-local/metadata 169.254.0.0/16";
  return null;
}

/** Loopback / ULA (fc00::/7) / link-local (fe80::/10) / unspecified IPv6,
 *  including IPv4-mapped forms (`::ffff:10.0.0.1`). */
function blockedV6(ip: string): string | null {
  const h = ip.toLowerCase();
  // URL normalizes IPv4-mapped to hex (`::ffff:10.0.0.1` → `::ffff:a00:1`), so
  // decode both shapes back to the embedded v4 and re-check the v4 ranges.
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const rest = mapped[1];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return blockedV4(rest);
    const g = rest.split(":");
    const hi = g.length === 2 ? parseInt(g[0], 16) : NaN;
    const lo = g.length === 2 ? parseInt(g[1], 16) : NaN;
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
    }
    return "IPv4-mapped IPv6 (unparseable)"; // conservative: refuse
  }
  if (h === "::1") return "loopback ::1";
  if (h === "::") return "unspecified ::";
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return "ULA fc00::/7";
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return "link-local fe80::/10";
  return null;
}

/** Endpoint allowlist for the proxy target. Returns an error string, or null
 *  when the URL is a public http(s) base (or the co-located daemon). */
function endpointError(raw: string): string | null {
  if (raw.length > MAX_ENDPOINT) return `endpoint must be ≤ ${MAX_ENDPOINT} chars`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "endpoint must be an absolute URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "endpoint must use http(s)";
  if (!u.hostname) return "endpoint must have a host";
  if (u.username || u.password) return "endpoint must not embed credentials";
  // URL.hostname keeps the brackets around an IPv6 literal ("[::1]").
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopbackHost = /^(?:127(?:\.\d+){1,3}|localhost|::1)$/.test(host);
  const blocked = host.includes(":") ? blockedV6(host) : blockedV4(host);
  if (blocked || loopbackHost) {
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (loopbackHost && port === CO_LOCATED_PORT) return null; // co-located daemon only
    return `endpoint host is not routable here (${blocked ?? "loopback"})`;
  }
  if (/(?:^|\.)localhost$/.test(host)) return "endpoint host is not routable here (loopback)";
  if (host === "metadata.google.internal") return "endpoint host is not routable here (metadata)";
  return null;
}

export async function POST(req: Request) {
  const authz = req.headers.get("authorization");
  if (!tokenOk(authz)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    owner?: unknown;
    name?: unknown;
    mode?: unknown;
    endpoint?: unknown;
    capabilities?: unknown;
  };

  if (typeof body.owner !== "string" || !body.owner) {
    return NextResponse.json({ error: "owner required" }, { status: 400 });
  }
  // A COMPLETE heartbeat or nothing: the row is a proxy target, so a partial
  // body must never null/replace the live row's endpoint or capabilities.
  if (body.mode === undefined) {
    return NextResponse.json({ error: "mode required" }, { status: 400 });
  }
  // 5a ships inbound only — a poll row would be proxied by 23 routes into
  // 502s instead of clean daemon-less degradation (review 2026-10-21).
  if (body.mode !== "inbound") {
    return NextResponse.json({ error: `mode '${String(body.mode)}' not accepted yet` }, { status: 400 });
  }
  if (typeof body.endpoint !== "string" || !body.endpoint) {
    return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  }
  if (body.capabilities === undefined || body.capabilities === null) {
    return NextResponse.json({ error: "capabilities required" }, { status: 400 });
  }
  if (
    typeof body.capabilities !== "object" || Array.isArray(body.capabilities) ||
    JSON.stringify(body.capabilities).length > MAX_CAPABILITIES
  ) {
    return NextResponse.json(
      { error: `capabilities must be an object ≤ ${MAX_CAPABILITIES} bytes` },
      { status: 400 },
    );
  }
  const name = body.name === undefined ? "personal" : body.name;
  if (typeof name !== "string" || !name) {
    return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
  }
  if (name.length > MAX_NAME) {
    return NextResponse.json({ error: `name must be ≤ ${MAX_NAME} chars` }, { status: 400 });
  }
  // The endpoint becomes a fetch base for proxying — an SSRF surface if the
  // token leaks, hence the private-range blocklist (fix wave D).
  const epErr = endpointError(body.endpoint);
  if (epErr) {
    return NextResponse.json({ error: epErr }, { status: 400 });
  }

  try {
    const ownerUserId = await getUserIdBySub(body.owner);
    if (!ownerUserId) {
      // Unknown uid — never fabricate a row for a stranger's recorder.
      return NextResponse.json({ error: "unknown owner" }, { status: 401 });
    }
    await upsertRecorderHeartbeat({
      ownerUserId,
      name,
      mode: "inbound",
      endpoint: body.endpoint,
      capabilities: body.capabilities as Record<string, unknown>,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[heartbeat] failed:", String(e).slice(0, 200));
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
