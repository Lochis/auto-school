"use client";
/** Notes/transcript panel that loads its markdown ON DEMAND — the course page
 *  used to SSR-render every session's full transcript (100KB+ each) into the
 *  HTML even though they sat in collapsed <details> (2s+ page loads).
 *  Fetches from /api/notes on first open; caches in state.
 *  Screen-2 chrome: "Class Notes" collapsible with an "AI Structured Summary"
 *  eyebrow that promotes OVERVIEW / KEY MILESTONES & ACTIONS sections (when
 *  the notes markdown contains them) into styled sections and side-by-side
 *  action item cards; the transcript collapsible shows segment/word counts. */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CheckCircleIcon, ChevronDownIcon, LinkIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { Eyebrow } from "@/components/ui";
import "../../sessions-ui.css";

/* ── markdown → structured sections ─────────────────────────────────── */

interface MdSection { heading: string; body: string }

function splitSections(md: string): MdSection[] {
  const out: MdSection[] = [];
  let cur: MdSection = { heading: "", body: "" };
  for (const ln of md.split("\n")) {
    const h = ln.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      if (cur.heading || cur.body.trim()) out.push(cur);
      cur = { heading: h[1].trim(), body: "" };
    } else {
      cur.body += ln + "\n";
    }
  }
  if (cur.heading || cur.body.trim()) out.push(cur);
  return out;
}

interface ActionItem { title: string; desc: string; done: boolean | null }

/** Parse the list items of a KEY MILESTONES & ACTIONS-style section into
 *  { title, desc } cards. Handles "- [x]/- [ ]" task lists and
 *  "**Title** — description" / "Title — description" shapes; non-list
 *  continuation lines append to the previous item's description. */
function actionItems(body: string): ActionItem[] {
  const items: ActionItem[] = [];
  for (const raw of body.split("\n")) {
    if (!raw.trim()) continue;
    const m = raw.match(/^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.*)$/);
    if (!m) {
      if (items.length) {
        const last = items[items.length - 1];
        const extra = raw.replace(/<[^>]*>/g, "").trim();
        if (extra) last.desc = `${last.desc} ${extra}`.trim();
      }
      continue;
    }
    const done = m[1] ? m[1].toLowerCase() === "x" : null;
    const text = m[2];
    let title = text;
    let desc = "";
    const bold = text.match(/^\*\*(.+?)\*\*\s*(?:[:—–-]\s*)?(.*)$/);
    if (bold) {
      title = bold[1];
      desc = bold[2];
    } else {
      const dash = text.match(/^(.{4,64}?)(?:\s+[—–]\s+|\s*[:：]\s+)(.+)$/);
      if (dash) {
        title = dash[1];
        desc = dash[2];
      }
    }
    items.push({
      title: title.replace(/\*\*/g, "").trim(),
      desc: desc.replace(/\*\*/g, "").trim(),
      done,
    });
  }
  return items;
}

function Md({ children }: { children: string }) {
  return (
    <div className="notes">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false }]]}>{children}</ReactMarkdown>
    </div>
  );
}

function NotesBody({ md }: { md: string }) {
  const sections = splitSections(md);
  const overview = sections.find((s) => /overview/i.test(s.heading))
    ?? (sections.length > 0 && !sections[0].heading ? sections[0] : null);
  const actionsSec = sections.find((s) => /milestone|action/i.test(s.heading));
  const rest = sections.filter((s) => s !== overview && s !== actionsSec);
  const items = actionsSec ? actionItems(actionsSec.body) : [];

  if (!overview && !actionsSec) {
    return <div className="sess-notes-scope"><Md>{md}</Md></div>;
  }
  return (
    <div className="sess-notes-scope" style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
      {overview && (
        <div className="sess-section">
          <Eyebrow>Overview</Eyebrow>
          <Md>{overview.body}</Md>
        </div>
      )}
      {actionsSec && (
        <div className="sess-section">
          <Eyebrow>Key Milestones &amp; Actions</Eyebrow>
          {items.length > 0 ? (
            <div className="sess-action-grid">
              {items.map((it, i) => {
                const chained = /due|deadline|11:59|freeze|lock|submit|deliverable/i.test(`${it.title} ${it.desc}`);
                const Icon = chained ? LinkIcon : CheckCircleIcon;
                return (
                  <div className="sess-action-card" key={i}>
                    <Icon
                      className="heroicon"
                      style={{ color: chained ? "var(--tertiary)" : "var(--primary)", marginTop: 2, flex: "none" }}
                    />
                    <div className="sess-action-text">
                      <span className="sess-action-title" style={it.done === false ? { opacity: 0.65 } : undefined}>{it.title}</span>
                      {it.desc && <span className="sess-action-desc">{it.desc}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Md>{actionsSec.body}</Md>
          )}
        </div>
      )}
      {rest.map((s, i) => (
        <Md key={i}>{`### ${s.heading}\n\n${s.body}`}</Md>
      ))}
    </div>
  );
}

/* ── component ──────────────────────────────────────────────────────── */

export default function LazyNotes({ course, stem, kind, title, segments, eager = false }: {
  course: string;
  stem: string;
  kind: "notes" | "running" | "transcript";
  title?: string;
  /** known segment count (from the timeline), to show before the load */
  segments?: number;
  eager?: boolean;
}) {
  const [md, setMd] = useState<string | null>(null); // "" = loading
  const [err, setErr] = useState("");
  const [fired, setFired] = useState(false);

  const load = (): void => {
    if (fired) return;
    setFired(true);
    setMd("");
    fetch(`/api/notes?course=${encodeURIComponent(course)}&stem=${encodeURIComponent(stem)}&kind=${kind}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { markdown: string }) => setMd(j.markdown))
      .catch((e) => { setErr(String(e)); setMd(null); });
  };
  useEffect(() => { if (eager) load(); }, []); // eager: fetch after mount, paint isn't blocked

  const isTranscript = kind === "transcript";
  const segCount = segments ?? (md ? (md.match(/\*\*\[\d+:\d+\]\*\*/g)?.length ?? null) : null);
  const wordCount = md
    ? md.replace(/```[\s\S]*?```/g, " ").replace(/\*\*\[[\d:]+\]\*\*/g, " ").split(/\s+/).filter(Boolean).length
    : null;
  const defaultTitle = kind === "notes" ? "Class Notes" : kind === "transcript" ? "Transcript (Merged Stems)" : "Running Summary";

  return (
    <details
      className={`sess-collapse ${isTranscript ? "sess-collapse--bare" : "sess-collapse--notes"}`}
      open={eager || undefined}
      onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) load(); }}
    >
      <summary>
        <span className="sess-collapse-label">
          <ChevronDownIcon className="heroicon sess-chev" />
          {title ?? defaultTitle}
        </span>
        <span className="sess-collapse-right">
          {kind === "notes" ? (
            <Eyebrow tone="emerald"><SparklesIcon className="heroicon" /> AI Structured Summary</Eyebrow>
          ) : isTranscript ? (
            <>
              {segCount !== null && segCount > 0 && <span>{segCount} segment{segCount === 1 ? "" : "s"}</span>}
              {wordCount !== null && <span>· {wordCount.toLocaleString()} words</span>}
            </>
          ) : null}
        </span>
      </summary>
      <div className="sess-collapse-body">
        {err && <p className="err">{err}</p>}
        {md === "" && <p className="muted">loading…</p>}
        {md && (isTranscript ? <Md>{md}</Md> : <NotesBody md={md} />)}
      </div>
    </details>
  );
}
