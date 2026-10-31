/** Internal daemon-hop auth (X-Internal-Auth) — the shared sign/verify core.
 *
 *  Replay hardening (security re-audit 2026-10-31): the original scheme signed
 *  `sub` alone, so a captured `X-Auto-School-User` + `X-Internal-Auth` pair
 *  could be replayed against :7800 forever (NetworkPolicy limits the audience
 *  but not the lifetime). The signed message is now `sub + "." + ts + "." +
 *  nonce` (ts = epoch ms, nonce = 16 random bytes hex), with the ts/nonce sent
 *  as PLAINTEXT companion headers (`X-Internal-Ts` / `X-Internal-Nonce`) so
 *  the daemon can reconstruct the message without decryption:
 *    X-Internal-Auth:   hex(HMAC-SHA256(INTERNAL_HMAC_KEY, sub.ts.nonce))
 *    X-Auto-School-User: <sub>
 *    X-Internal-Ts:     <ts>   X-Internal-Nonce: <nonce>
 *
 *  The verifier (used by src/daemon.ts resolveRequestOwner) is fail-closed and
 *  state-oracle-free: every rejection maps to the same 401 upstream. The
 *  ts+nonce seen-set is injected (`seen`) so the caller owns the process-local
 *  state — single-recorder-pod assumption; horizontal scaling would need a
 *  shared store (documented follow-up).
 *
 *  LEGACY fallback (rollout window only): old frontend pods sign `sub` alone
 *  with NO ts/nonce headers. Accept that ONLY when both companion headers are
 *  absent (a half-signed request — exactly one present — is rejected); the
 *  HMAC-over-sub check itself is unchanged, so legacy stays fail-closed. The
 *  daemon logs a rate-limited deprecation warning per legacy verify; remove
 *  this branch next release. */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Max |now − ts| accepted (both pods run TZ-synced via k8s). */
export const INTERNAL_TS_SKEW_MS = 5 * 60_000;
/** Seen-set entry lifetime. Must exceed the skew window (5 min) so a replay
 *  inside the validity horizon is always caught; swept on every insert. */
export const INTERNAL_NONCE_TTL_MS = 6 * 60_000;

/** The frontend's signing primitive (mirrored in frontend/src/lib/owner.ts
 *  internalAuthHmac — keep the message format identical on both sides). */
export function signInternalAuth(secret: string, sub: string, ts: string | number, nonce: string): string {
  return createHmac("sha256", secret).update(`${sub}.${ts}.${nonce}`).digest("hex");
}

export type InternalAuthResult = { ok: true } | { ok: false; reason: string };

/** `seen` maps `"ts.nonce"` → expiry epoch ms; pass undefined to skip replay
 *  state (tests). Check-and-record happens synchronously (no await) so the
 *  single-threaded event loop makes it atomic. */
export interface InternalAuthInput {
  secret: string;
  sub: string;
  sig: string;
  ts?: string;
  nonce?: string;
  nowMs?: number;
  seen?: Map<string, number>;
}

/** Verify one daemon-hop signature. Order matters: format → freshness → HMAC
 *  → nonce. Nonces are recorded ONLY after the HMAC passes, so garbage
 *  requests can never poison the seen-set (no pre-play DoS of future hops). */
export function verifyInternalAuth(input: InternalAuthInput): InternalAuthResult {
  const { secret, sub, sig } = input;
  const now = input.nowMs ?? Date.now();
  if (!sub || !sig || !secret) return { ok: false, reason: "missing sub/sig/secret" };

  // Legacy detection: BOTH companion headers absent → legacy sub-only message.
  // Exactly one present is a broken new-format request → reject (fail-closed).
  const hasTs = !!input.ts;
  const hasNonce = !!input.nonce;
  if (hasTs !== hasNonce) return { ok: false, reason: "half-signed (one of X-Internal-Ts/X-Internal-Nonce missing)" };

  if (hasTs) {
    const ts = Number(input.ts);
    if (!Number.isSafeInteger(ts) || ts <= 0) return { ok: false, reason: "malformed ts" };
    if (Math.abs(now - ts) > INTERNAL_TS_SKEW_MS) return { ok: false, reason: "stale ts (> 5min skew)" };
  }

  const message = hasTs ? `${sub}.${input.ts}.${input.nonce}` : sub;
  const want = createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(sig, "hex"), b = Buffer.from(want, "hex");
  // Buffer.from("zz","hex") yields an empty/short buffer — the length test
  // rejects malformed hex before timingSafeEqual (which throws on mismatch)
  if (a.length !== b.length || a.length !== 32 || !timingSafeEqual(a, b)) return { ok: false, reason: "hmac mismatch" };

  if (hasTs && input.seen) {
    const key = `${input.ts}.${input.nonce}`;
    for (const [k, exp] of input.seen) if (exp <= now) input.seen.delete(k); // TTL sweep on insert
    if (input.seen.has(key)) return { ok: false, reason: "replayed ts+nonce" };
    input.seen.set(key, now + INTERNAL_NONCE_TTL_MS);
  }
  return { ok: true };
}
