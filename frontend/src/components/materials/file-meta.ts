/** Shared material-tree helpers: entry shape, tree builder, node sorting,
 *  extension-derived file kind (icon + category tag), size formatting. */
import type { ComponentType, SVGProps } from "react";
import {
  ArchiveBoxIcon,
  CodeBracketIcon,
  DocumentIcon,
  DocumentTextIcon,
  FilmIcon,
  MusicalNoteIcon,
  PhotoIcon,
  PresentationChartLineIcon,
  TableCellsIcon,
} from "@heroicons/react/24/outline";

/** A stored course material (mirrors the backend GET /materials payload). */
export interface Entry {
  path: string;
  filename: string;
  week: number | null;
  category: string;
  description: string;
  uploadedAt: string;
  size: number;
}

/** Tree node built from slash-separated material paths. */
export interface TNode {
  name: string;
  path: string;
  children: Map<string, TNode>;
  file?: Entry;
}

/** Build a nested tree from flat entries. */
export function buildTree(entries: Entry[]): TNode {
  const root: TNode = { name: "", path: "", children: new Map() };
  for (const e of entries) {
    let cur = root;
    const segs = e.path.split("/");
    segs.forEach((seg, i) => {
      const p = segs.slice(0, i + 1).join("/");
      if (!cur.children.has(seg)) cur.children.set(seg, { name: seg, path: p, children: new Map() });
      cur = cur.children.get(seg)!;
      if (i === segs.length - 1) cur.file = e; // leaf
    });
  }
  return root;
}

/** All file entries under a node (not counting the node's own file). */
export function filesUnder(n: TNode): Entry[] {
  const out: Entry[] = [];
  const walk = (x: TNode): void => {
    if (x.file) out.push(x.file);
    for (const c of x.children.values()) walk(c);
  };
  for (const c of n.children.values()) walk(c);
  return out;
}

/** Folders first, ".index" pinned up top, natural-order names ("Week 2" < "Week 10"). */
export function sortNodes(nodes: Iterable<TNode>): TNode[] {
  const arr = [...nodes];
  arr.sort((a, b) => {
    const af = a.file ? 1 : 0;
    const bf = b.file ? 1 : 0;
    if (af !== bf) return af - bf;
    if (!af && a.name === ".index") return -1;
    if (!af && b.name === ".index") return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return arr;
}

export const fmtSize = (b: number): string =>
  b >= 1e9
    ? `${(b / 1e9).toFixed(2)} GB`
    : b > 1e6
      ? `${(b / 1e6).toFixed(1)} MB`
      : `${Math.max(1, Math.round(b / 1e3))} KB`;

export type MatTone = "neutral" | "emerald" | "indigo" | "cyan" | "red";

export interface FileKind {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** uppercase category tag derived from the extension */
  category: string;
  /** chip tone for the category tag */
  tone: MatTone;
  /** icon tint class (materials-ui.css) */
  iconClass: string;
}

/** Extension → icon + category tag + tones. */
export function kindFor(filename: string): FileKind {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "pdf":
      return { Icon: DocumentTextIcon, category: "PDF", tone: "red", iconClass: "mat-ic-red" };
    case "doc":
    case "docx":
    case "odt":
    case "rtf":
      return { Icon: DocumentIcon, category: ext.toUpperCase(), tone: "indigo", iconClass: "mat-ic-indigo" };
    case "ppt":
    case "pptx":
      return { Icon: PresentationChartLineIcon, category: ext.toUpperCase(), tone: "indigo", iconClass: "mat-ic-indigo" };
    case "mp4":
    case "webm":
    case "mov":
    case "mkv":
    case "m4v":
      return { Icon: FilmIcon, category: ext.toUpperCase(), tone: "cyan", iconClass: "mat-ic-cyan" };
    case "mp3":
    case "wav":
    case "m4a":
    case "aac":
      return { Icon: MusicalNoteIcon, category: "AUDIO", tone: "cyan", iconClass: "mat-ic-cyan" };
    case "xls":
    case "xlsx":
    case "csv":
      return { Icon: TableCellsIcon, category: ext.toUpperCase(), tone: "emerald", iconClass: "mat-ic-emerald" };
    case "zip":
    case "7z":
    case "rar":
    case "tar":
    case "gz":
      return { Icon: ArchiveBoxIcon, category: ext.toUpperCase(), tone: "neutral", iconClass: "mat-ic-muted" };
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
      return { Icon: PhotoIcon, category: "IMAGE", tone: "cyan", iconClass: "mat-ic-cyan" };
    case "txt":
    case "md":
    case "vtt":
    case "srt":
      return { Icon: DocumentTextIcon, category: "TEXT", tone: "neutral", iconClass: "mat-ic-muted" };
    case "js":
    case "ts":
    case "py":
    case "json":
    case "html":
    case "css":
      return { Icon: CodeBracketIcon, category: "CODE", tone: "neutral", iconClass: "mat-ic-muted" };
    default:
      return { Icon: DocumentIcon, category: ext ? ext.toUpperCase() : "FILE", tone: "neutral", iconClass: "mat-ic-muted" };
  }
}
