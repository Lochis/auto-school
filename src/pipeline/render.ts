/** Markdown → printable PDF via headless Chromium — the same browser
 *  channel the recorder and the docx→pdf pipeline use, so no extra image
 *  weight. Used for AI-generated study sheets (dense, two-column A4).
 *  Never launches a browser while a recording is live (second browser
 *  launch during capture is the one real risk) — callers get `false` and
 *  can fall back to the markdown alone.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { marked } from "marked";
import { config } from "../config.ts";
import { listSessions } from "./sessions.ts";

/** Print-focused stylesheet: two dense A4 columns, compact tables, visible
 *  formula/code boxes — cheat-sheet typography, not article typography. */
const SHEET_CSS = `
  @page { size: A4; margin: 9mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Liberation Sans', Arial, sans-serif; font-size: 8.2pt;
         line-height: 1.32; color: #111; column-count: 2; column-gap: 7mm; }
  h1 { font-size: 12.5pt; margin: 0 0 4pt; column-span: all; border-bottom: 1.5pt solid #111; padding-bottom: 2pt; }
  h2 { font-size: 9.6pt; margin: 5pt 0 2pt; background: #eee; padding: 1.5pt 4pt;
       border-left: 2.5pt solid #333; break-after: avoid; }
  h3 { font-size: 8.6pt; margin: 3pt 0 1pt; break-after: avoid; }
  p { margin: 0 0 3pt; }
  ul, ol { margin: 0 0 3pt; padding-left: 12pt; }
  li { margin: 0 0 1pt; }
  table { border-collapse: collapse; width: 100%; margin: 2pt 0 4pt; font-size: 7.6pt; }
  th, td { border: 0.6pt solid #888; padding: 1.5pt 3pt; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  code { font-family: 'Liberation Mono', monospace; font-size: 7.6pt; background: #f4f4f4;
         padding: 0 2pt; border: 0.5pt solid #ddd; border-radius: 2pt; }
  pre { background: #f4f4f4; border: 0.5pt solid #ddd; padding: 3pt; margin: 2pt 0 4pt; break-inside: avoid; }
  pre code { background: none; border: none; }
  blockquote { margin: 2pt 0 3pt; padding: 1pt 5pt; border-left: 2pt solid #999; color: #333; }
  hr { border: none; border-top: 0.6pt solid #aaa; margin: 4pt 0; }
  strong { background: #fff3c4; } /* exam-critical terms pop on paper */
`;

/** Render markdown to `outPdf`. Returns false when a recording is live or
 *  the browser/print fails — the caller keeps the .md and reports. */
export async function mdToPdf(md: string, outPdf: string): Promise<boolean> {
  if (listSessions().some((s) => s.stage === "recording")) {
    console.log("[render] recording live — skipping md→pdf (md saved, pdf deferred)");
    return false;
  }
  try {
    const html = await marked.parse(md, { gfm: true, breaks: false });
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      channel: config.browserChannel,
      chromiumSandbox: config.chromiumSandbox,
      timeout: 60_000,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>${SHEET_CSS}</style></head><body>${html}</body></html>`,
        { waitUntil: "load", timeout: 60_000 },
      );
      mkdirSync(dirname(outPdf), { recursive: true });
      await page.pdf({ path: outPdf, format: "A4", printBackground: true, preferCSSPageSize: true });
      return true;
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    console.warn(`[render] md→pdf failed: ${String(e).slice(0, 140)}`);
    return false;
  }
}
