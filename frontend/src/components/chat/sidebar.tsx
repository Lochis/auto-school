"use client";
/** Right rail of the course "Ask" tab (stitch screen 3): real-data panels —
 *  "Source Documents" (indexed materials of this course, click to preview)
 *  and "Next Deliverable" (nearest upcoming deadline of this course from
 *  /api/deadlines with its checklist from /api/checklists, interactive). */
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  ArrowPathIcon, ArrowTopRightOnSquareIcon, BookOpenIcon, CheckIcon,
  CodeBracketIcon, DocumentTextIcon, FlagIcon, MusicalNoteIcon,
  PhotoIcon, VideoCameraIcon,
} from "@heroicons/react/24/outline";
import { Badge, Panel, ProgressRing } from "@/components/ui";
import type { Checklist, DeadEntryLite, MaterialEntry } from "./types";

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

function daysUntil(date: string): number {
  return Math.round((Date.parse(`${date}T12:00:00`) - Date.now()) / 86_400_000);
}

/* ── Source Documents ────────────────────────────────────────────────── */

export function SourceDocuments({ slug, materials, onOpenPreview }: {
  slug: string;
  materials: MaterialEntry[];
  onOpenPreview: (course: string, path: string) => void;
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
      actions={<span className="chat-token-count">{rows.length} Indexed</span>}
    >
      <div className="chat-src-list">
        {rows.length === 0 && (
          <p className="muted" style={{ margin: 0, fontSize: "0.8125rem" }}>
            No materials indexed yet — upload some on the Materials tab.
          </p>
        )}
        {rows.map((m) => {
          const { Icon, tone } = fileGlyph(m.filename);
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
                  <span className="chat-src-name">{m.filename}</span>
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

/* ── Next Deliverable (deadline + interactive checklist) ─────────────── */

function NextDeliverable({ slug }: { slug: string }) {
  const [deadline, setDeadline] = useState<DeadEntryLite | null>(null);
  const [ck, setCk] = useState<Checklist | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [genBusy, setGenBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/deadlines").then((r) => r.json()).catch(() => ({})),
      fetch("/api/checklists").then((r) => r.json()).catch(() => ({})),
    ]).then(([dj, cj]: [{ deadlines?: DeadEntryLite[] }, { checklists?: Checklist[] }]) => {
      if (!alive) return;
      setLoaded(true);
      const upcoming = (dj.deadlines ?? [])
        .filter((d) => d.course === slug && !d.done && d.due)
        .sort((a, b) => (a.due! < b.due! ? -1 : 1));
      const next = upcoming.find((d) => daysUntil(d.due!) >= 0) ?? upcoming[0] ?? null;
      setDeadline(next);
      if (next) setCk((cj.checklists ?? []).find((c) => c.deadlineId === next.id) ?? null);
    });
    return () => { alive = false; };
  }, [slug]);

  const toggle = useCallback(async (itemId: string): Promise<void> => {
    if (!deadline) return;
    setCk((c) => c ? {
      ...c,
      items: c.items.map((it) => (it.id === itemId ? { ...it, done: !it.done } : it)),
    } : c);
    try {
      const r = await fetch("/api/checklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deadlineId: deadline.id, itemId }),
      });
      const j = (await r.json().catch(() => ({}))) as { checklists?: Checklist[] };
      const fresh = j.checklists?.find((c) => c.deadlineId === deadline.id);
      if (fresh) setCk(fresh);
    } catch { /* optimistic state stands */ }
  }, [deadline]);

  const generate = useCallback(async (): Promise<void> => {
    if (!deadline || genBusy) return;
    setGenBusy(true);
    try {
      const r = await fetch("/api/checklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deadlineId: deadline.id }),
      });
      const j = (await r.json().catch(() => ({}))) as { checklists?: Checklist[]; error?: string };
      const fresh = j.checklists?.find((c) => c.deadlineId === deadline.id);
      if (fresh) setCk(fresh);
    } catch { /* leave as-is */ }
    finally { setGenBusy(false); }
  }, [deadline, genBusy]);

  if (!loaded || !deadline) return null; // nothing upcoming for this course — omit

  const dueIn = deadline.due ? daysUntil(deadline.due) : null;
  const chip = dueIn === null ? null
    : dueIn < 0 ? <Badge variant="red">{-dueIn}D overdue</Badge>
    : dueIn === 0 ? <Badge variant="emerald">Due today</Badge>
    : dueIn === 1 ? <Badge variant="emerald">Due tomorrow</Badge>
    : <Badge variant="emerald">In {dueIn} Days</Badge>;

  const items = ck?.items ?? [];
  const doneN = items.filter((i) => i.done).length;
  const pct = items.length > 0 ? Math.round((doneN / items.length) * 100) : 0;
  const dueLabel = deadline.due
    ? `Due ${deadline.due}${new Date(`${deadline.due}T12:00:00`).toLocaleDateString("en-CA", { weekday: "short" })} @ 23:59`
    : "";

  return (
    <Panel
      icon={<FlagIcon className="heroicon" style={{ color: "var(--secondary)" }} />}
      title="Next Deliverable"
      actions={chip}
    >
      <div className="chat-nd">
        <ProgressRing value={pct} label={`${pct}%`} size={64} strokeWidth={6} />
        <div className="chat-nd-main">
          <span className="chat-nd-title" title={deadline.title}>{deadline.title}</span>
          <span className="chat-nd-due">{dueLabel}</span>
          {deadline.kind ? <span className="chat-nd-sub">{deadline.kind}</span> : null}
        </div>
      </div>
      {items.length > 0 ? (
        <div className="chat-ck-list" style={{ marginTop: "var(--space-sm)" }}>
          {items.map((it) => (
            <button key={it.id} type="button" className={`chat-ck ${it.done ? "chat-ck--done" : ""}`.trim()} onClick={() => void toggle(it.id)}>
              <span className="chat-ck-box"><CheckIcon className="heroicon" style={{ width: 12, height: 12 }} /></span>
              <span className="chat-ck-text">{it.text}</span>
            </button>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "var(--space-sm)" }}>
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            {genBusy ? "building… (reads the task sheet — can take a minute)" : "No checklist yet."}
          </span>
          {!genBusy && (
            <button type="button" className="btn btn-micro" onClick={() => void generate()} title="AI-generate an execution checklist for this deliverable">
              <ArrowPathIcon className="heroicon" style={{ width: 12, height: 12 }} /> Generate
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ── Rail ────────────────────────────────────────────────────────────── */

export default function ChatSidebar({ slug, materials, onOpenPreview }: {
  slug: string;
  materials: MaterialEntry[];
  onOpenPreview: (course: string, path: string) => void;
}) {
  return (
    <aside className="chat-rail">
      <NextDeliverable slug={slug} />
    </aside>
  );
}
