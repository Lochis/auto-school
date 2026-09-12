/**
 * Document bundles: a uniform per-file index under
 * courses/<slug>/materials/.index/<rel-path>/ — page-NNN.txt (and page-NNN.png
 * for PDFs). Any course, any doc: the chat tools always read the same layout.
 * Indexing is LAZY — the first read_document/view_page pays the cost, so
 * uploads stay instant and untouched docs never burn CPU/vision quota.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { MATERIALS_DIR } from "./materials.ts";
import { listSessions } from "./sessions.ts";
import { config } from "../config.ts";

const run = (cmd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise((res) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code, out, err }));
    p.on("error", (e) => res({ code: -1, out, err: String(e) }));
  });

const TEXTUAL = new Set([".md", ".txt", ".csv", ".json", ".ts", ".js", ".py", ".sql", ".xml", ".yml", ".yaml", ".log"]);
const SHEETLY = new Set([".xlsx", ".xls"]);
const pageNum = (f: string): number => Number(f.match(/page-(\d+)\.txt$/)?.[1] ?? 0);

/** .index/<relPath>/ for a material — mirrors the tree, extension stripped per leaf. */
export const indexDir = (course: string, rel: string): string =>
  join(MATERIALS_DIR(course), ".index", rel.replace(/\.[^.]+$/, ""));

export const supportsIndex = (rel: string): boolean => {
  const e = extname(rel).toLowerCase();
  return e === ".pdf" || e === ".docx" || SHEETLY.has(e) || TEXTUAL.has(e);
};

/** PDF → page texts + page PNGs in the bundle dir (shared by real PDFs and
 *  rendered DOCXs). Returns page count. */
async function indexPdf(src: string, dir: string): Promise<number> {
  const t = await run("pdftotext", ["-enc", "UTF-8", src, "-"]);
  const parts = t.out.split("\f");
  parts.forEach((txt, i) => writeFileSync(join(dir, `page-${i + 1}.txt`), txt.trim()));
  await run("pdftoppm", ["-png", "-r", "110", src, join(dir, "page")]); // page-1.png … (padding varies)
  return Math.max(parts.length, 1);
}

/** DOCX → HTML (images inline as data-URIs) → headless print-to-PDF → normal
 *  PDF pipeline. Reuses the same browser/channel the recorder uses — no extra
 *  image weight. Never runs while a recording session is live (second browser
 *  launch during capture is the one real risk). */
async function docxToPdf(src: string, dir: string): Promise<string | null> {
  try {
    const mammoth = await import("mammoth");
    const { value: html } = await mammoth.convertToHtml({ path: src });
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
        `<!doctype html><html><head><meta charset="utf-8"><style>
          body{font-family:'Liberation Sans',sans-serif;font-size:12pt;margin:1.5cm;}
          img{max-width:100%;height:auto;}
          table{border-collapse:collapse;}td,th{border:1px solid #999;padding:4px 8px;}
          h1,h2,h3{page-break-after:avoid;}
        </style></head><body>${html}</body></html>`,
        { waitUntil: "load", timeout: 60_000 },
      );
      const pdf = join(dir, "source.pdf");
      await page.pdf({ path: pdf, format: "A4", printBackground: true });
      return pdf;
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    console.warn(`[docindex] docx→pdf failed for ${src.split("/").pop()}: ${String(e).slice(0, 120)} — falling back to text-only`);
    return null;
  }
}

/** Build the bundle if missing. Returns page count, or 0 when unsupported. */
export async function ensureIndex(course: string, rel: string): Promise<number> {
  if (!supportsIndex(rel)) return 0;
  const dir = indexDir(course, rel);
  const src = join(MATERIALS_DIR(course), rel);
  if (!existsSync(src)) return 0;
  const deferred = existsSync(join(dir, ".textonly")); // text-only fallback — upgrade when possible
  const existing = pagesOnDisk(dir);
  if (existing > 0 && !deferred) return existing;
  mkdirSync(dir, { recursive: true });
  const ext = extname(rel).toLowerCase();

  if (ext === ".pdf") {
    return indexPdf(src, dir);
  }
  if (SHEETLY.has(ext)) {
    // spreadsheet → one "page" per sheet, CSV-formatted (computed values)
    const X = await import("xlsx");
    const XLSX = X.default ?? X; // CJS interop: readFile lives on default in node ESM
    const wb = XLSX.readFile(src, { cellDates: true });
    const names = wb.SheetNames.slice(0, 20);
    names.forEach((name, i) => {
      let csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]!, { blankrows: false });
      const lines = csv.split("\n");
      if (lines.length > 200) csv = lines.slice(0, 200).join("\n") + "\n…(truncated at 200 rows)";
      writeFileSync(join(dir, `page-${i + 1}.txt`), `# Sheet: ${name}\n\n${csv.trim()}\n`);
    });
    return Math.max(names.length, 1);
  }
  if (ext === ".docx") {
    // during a live recording, never launch a second browser — text-only now,
    // full conversion on the next read after class ends
    const recordingLive = listSessions().some((s) => s.stage === "recording");
    if (!recordingLive) {
      const pdf = await docxToPdf(src, dir);
      if (pdf) {
        // rendered pdf replaces the text-only fallback (if any)
        for (const f of readdirSync(dir)) if (/^page-\d+\.txt$/.test(f)) unlinkSync(join(dir, f));
        try { unlinkSync(join(dir, ".textonly")); } catch { /* gone */ }
        return indexPdf(pdf, dir);
      }
    }
    // text-only fallback (also the mid-class path) — marker ensures a later
    // read retries the full conversion
    writeFileSync(join(dir, ".textonly"), "deferred docx→pdf conversion");
    const mammoth = await import("mammoth");
    const { value: md } = await mammoth.convertToHtml({ path: src });
    const text = md
      .replace(/<h1[^>]*>/g, "\n# ").replace(/<h2[^>]*>/g, "\n## ").replace(/<h3[^>]*>/g, "\n### ")
      .replace(/<li[^>]*>/g, "\n- ").replace(/<\/(p|li|tr|h1|h2|h3|table)>/g, "\n")
      .replace(/<td[^>]*>/g, " | ").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
    writeFileSync(join(dir, "page-1.txt"), text);
    return 1;
  }
  // textual passthrough — single page
  writeFileSync(join(dir, "page-1.txt"), readFileSync(src, "utf8"));
  return 1;
}

const pagesOnDisk = (dir: string): number => {
  try { return readdirSync(dir).filter((f) => /^page-\d+\.txt$/.test(f)).length; } catch { return 0; }
};

/** Read a page (1-based) or the whole doc. Caps output so one huge PDF can't eat the context. */
export async function readDoc(course: string, rel: string, page?: number, cap = 24_000): Promise<{ pages: number; page: number | null; text: string } | { error: string }> {
  if (!supportsIndex(rel)) return { error: `${rel}: ${extname(rel) || "unknown"} files aren't readable` };
  if (!existsSync(join(MATERIALS_DIR(course), rel))) return { error: `no such file: ${rel} — list_materials shows the exact paths` };
  const pages = await ensureIndex(course, rel);
  if (!pages) return { error: `indexing failed for ${rel}` };
  const dir = indexDir(course, rel);
  if (page) {
    if (page < 1 || page > pages) return { error: `page ${page} out of range (1-${pages})` };
    return { pages, page, text: readFileSync(join(dir, `page-${page}.txt`), "utf8").slice(0, 6_000) || "(no extractable text — try view_page for the image)" };
  }
  let out = "";
  for (let i = 1; i <= pages && out.length < cap; i++) {
    const t = readFileSync(join(dir, `page-${i}.txt`), "utf8");
    out += `--- page ${i}/${pages} ---\n${t}\n`;
    if (out.length > cap) out = out.slice(0, cap) + "\n…(truncated — request specific pages)";
  }
  return { pages, page: null, text: out.trim() || "(no extractable text)" };
}

/** Path of a rasterized page for the VLM (PDFs only). */
export async function pageImage(course: string, rel: string, page: number): Promise<string | null> {
  const ext = extname(rel).toLowerCase();
  if (ext !== ".pdf" && ext !== ".docx") return null;
  await ensureIndex(course, rel);
  const dir = indexDir(course, rel);
  // pdftoppm names vary (page-1.png / page-001.png) — match by number
  try {
    const hit = readdirSync(dir).find((f) => new RegExp(`page-0*${page}\\.png$`).test(f));
    return hit ? join(dir, hit) : null;
  } catch { return null; }
}

export const indexedPages = (course: string, rel: string): number => pagesOnDisk(indexDir(course, rel));
