/**
 * Document bundles: a uniform per-file index under
 * courses/<slug>/materials/.index/<rel-path>/ — page-NNN.txt (and page-NNN.png
 * for PDFs). Any course, any doc: the chat tools always read the same layout.
 * Indexing is LAZY — the first read_document/view_page pays the cost, so
 * uploads stay instant and untouched docs never burn CPU/vision quota.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { MATERIALS_DIR } from "./materials.ts";

const run = (cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> =>
  new Promise((res) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code, out, err }));
    p.on("error", (e) => res({ code: -1, out, err: String(e) }));
  });

const TEXTUAL = new Set([".md", ".txt", ".csv", ".json", ".ts", ".js", ".py", ".sql", ".xml", ".yml", ".yaml", ".log"]);
const pageNum = (f: string): number => Number(f.match(/page-(\d+)\.txt$/)?.[1] ?? 0);

/** .index/<relPath>/ for a material — mirrors the tree, extension stripped per leaf. */
export const indexDir = (course: string, rel: string): string =>
  join(MATERIALS_DIR(course), ".index", rel.replace(/\.[^.]+$/, ""));

export const supportsIndex = (rel: string): boolean => {
  const e = extname(rel).toLowerCase();
  return e === ".pdf" || e === ".docx" || TEXTUAL.has(e);
};

/** Build the bundle if missing. Returns page count, or 0 when unsupported. */
export async function ensureIndex(course: string, rel: string): Promise<number> {
  if (!supportsIndex(rel)) return 0;
  const dir = indexDir(course, rel);
  const src = join(MATERIALS_DIR(course), rel);
  if (!existsSync(src)) return 0;
  const existing = pagesOnDisk(dir);
  if (existing > 0) return existing;
  mkdirSync(dir, { recursive: true });
  const ext = extname(rel).toLowerCase();

  if (ext === ".pdf") {
    // full-text pass with \f page breaks, then rasterize pages for the VLM
    const t = await run("pdftotext", ["-enc", "UTF-8", src, "-"]);
    const parts = t.out.split("\f");
    parts.forEach((txt, i) => writeFileSync(join(dir, `page-${i + 1}.txt`), txt.trim()));
    const n = parts.length;
    await run("pdftoppm", ["-png", "-r", "110", src, join(dir, "page")]); // page-1.png … (padding varies)
    return Math.max(n, 1);
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value: md } = await mammoth.convertToHtml({ path: src }); // h1/h2/p tables — images dropped v1
    // html → markdown-lite: keep headings/lists/paragraphs readable
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
  const pages = await ensureIndex(course, rel);
  if (!pages) return { error: `no index for ${rel} (${extname(rel) || "unknown"} not supported yet)` };
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
  if (extname(rel).toLowerCase() !== ".pdf") return null;
  await ensureIndex(course, rel);
  const dir = indexDir(course, rel);
  // pdftoppm names vary (page-1.png / page-001.png) — match by number
  try {
    const hit = readdirSync(dir).find((f) => new RegExp(`page-0*${page}\\.png$`).test(f));
    return hit ? join(dir, hit) : null;
  } catch { return null; }
}

export const indexedPages = (course: string, rel: string): number => pagesOnDisk(indexDir(course, rel));
