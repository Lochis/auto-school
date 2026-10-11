"use client";
/** Source Documents panel (stitch screen 3): the course's indexed materials,
 *  click a row to preview it in the doc modal. Rendered collapsibly above the
 *  chat thread. */
import { useMemo, type ComponentType } from "react";
import {
  ArrowTopRightOnSquareIcon, BookOpenIcon, CircleStackIcon, CodeBracketIcon,
  DocumentTextIcon, MusicalNoteIcon, PhotoIcon, VideoCameraIcon,
} from "@heroicons/react/24/outline";
import { Panel } from "@/components/ui";
import type { MaterialEntry } from "./types";

type IconCmp = ComponentType<{ className?: string; style?: React.CSSProperties }>;

function fmtSize(n?: number): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileGlyph(filename: string): { Icon: IconCmp; tone: string } {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "pdf") return { Icon: DocumentTextIcon, tone: "icon-tile--red" };
  if (["doc", "docx", "txt", "md"].includes(ext)) return { Icon: BookOpenIcon, tone: "icon-tile--indigo" };
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return { Icon: PhotoIcon, tone: "icon-tile--cyan" };
  if (["mp4", "mkv", "webm", "mov", "avi"].includes(ext)) return { Icon: VideoCameraIcon, tone: "icon-tile--cyan" };
  if (["mp3", "wav", "m4a", "opus"].includes(ext)) return { Icon: MusicalNoteIcon, tone: "icon-tile--emerald" };
  if (["zip", "7z", "rar", "gz", "js", "ts", "py", "java", "cs", "sql"].includes(ext)) return { Icon: CodeBracketIcon, tone: "icon-tile--emerald" };
  return { Icon: DocumentTextIcon, tone: "" };
}

/* ── Source Documents ────────────────────────────────────────────────── */

export function SourceDocuments({ slug, materials, onOpenPreview, showIndexed = false, onToggleIndexed }: {
  slug: string;
  materials: MaterialEntry[];
  onOpenPreview: (course: string, path: string) => void;
  /** show the machine-extracted .index/ page cache too (default hidden) */
  showIndexed?: boolean;
  onToggleIndexed?: () => void;
}) {
  // newest uploads first — the freshest context is what the chat indexes
  const rows = useMemo(
    () => [...materials].sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? "")),
    [materials],
  );
  return (
    <Panel
      icon={<BookOpenIcon className="heroicon" />}
      title="Source Documents"
      actions={
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
          {onToggleIndexed && (
            <button
              type="button"
              className={`chat-web-btn ${showIndexed ? "chat-web-btn--on" : ""}`.trim()}
              onClick={onToggleIndexed}
              title="Toggle the machine-extracted .index page cache — plain text/PNG pages the Ask AI pipeline derives from your documents"
            >
              <CircleStackIcon className="heroicon" style={{ display: "inline", width: 14, height: 14 }} />
              Indexed {showIndexed ? "on" : "off"}
            </button>
          )}
          <span className="chat-token-count">{rows.length} Indexed</span>
        </span>
      }
    >
      <div className="chat-src-list">
        {rows.length === 0 && (
          <p className="muted" style={{ margin: 0, fontSize: "0.8125rem" }}>
            No materials indexed yet — upload some on the Materials tab.
          </p>
        )}
        {rows.map((m) => {
          const { Icon, tone } = fileGlyph(m.filename);
          // .index cache rows: "page-3.txt" alone is meaningless — show the
          // source doc it was extracted from
          const label = m.path.startsWith(".index/")
            ? m.path.split("/").slice(-2).join(" · ")
            : m.filename;
          const meta = [
            fmtSize(m.size),
            m.uploadedAt ? `updated ${new Date(m.uploadedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}` : m.category,
          ].filter(Boolean).join(" • ");
          return (
            <button
              key={m.path}
              type="button"
              className="chat-src-row"
              onClick={() => onOpenPreview(slug, m.path)}
              title={`open ${m.path}`}
            >
              <span className="chat-src-main">
                <span className={`icon-tile ${tone}`.trim()}><Icon className="heroicon" /></span>
                <span style={{ minWidth: 0 }}>
                  <span className="chat-src-name">{label}</span>
                  <span className="chat-src-meta">{meta || m.path}</span>
                </span>
              </span>
              <ArrowTopRightOnSquareIcon className="heroicon chat-src-open" />
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
