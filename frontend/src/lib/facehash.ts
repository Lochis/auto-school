/** FaceHash — deterministic identicon fallback for users with no stored
 *  avatar (Gap 4b, docs/planning/personal-not-commercial-phase3-gaps.md).
 *  Zero deps, no network: sha256(seed) drives a 5×5 horizontally-mirrored
 *  grid plus an hsl foreground, so the same seed always renders the exact
 *  same SVG. Server-only (node:crypto); served by /api/me/avatar under the
 *  same CSP/nosniff hardening as stored (SVG) avatars — never inlined. */
import { createHash } from "node:crypto";

/** Deterministic identicon SVG for `seed` (the authentik uid — not the
 *  username, which is a mutable handle). Mirrored 5×5 grid: cells come from
 *  hash bits; color (full-spectrum hue, mid sat/lightness) from the leading
 *  bytes so every seed gets a stable, distinct look. */
export function facehashSvg(seed: string, size = 64): string {
  const h = createHash("sha256").update(seed).digest();
  const hue = Math.round((h[0]! / 255) * 360); // 0–360
  const sat = Math.round(55 + (h[1]! / 255) * 15); // 55–70%
  const light = Math.round(45 + (h[2]! / 255) * 15); // 45–60%
  const fg = `hsl(${hue} ${sat}% ${light}%)`;

  // 15 cells = left 3 columns (incl. center); column x mirrors to 4−x.
  // One bit per cell, walking bytes 3..17 (bit 0 of each byte).
  const cells: string[] = [];
  for (let i = 0; i < 15; i++) {
    if ((h[3 + i]! & 1) === 0) continue;
    const x = i % 3;
    const y = Math.floor(i / 3);
    const rect = (cx: number) =>
      `<rect x="${cx}" y="${y}" width="1" height="1" fill="${fg}"/>`;
    cells.push(rect(x));
    if (x !== 2) cells.push(rect(4 - x));
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="5" height="5" fill="#f0f0f0"/>` +
    `${cells.join("")}</svg>`
  );
}
