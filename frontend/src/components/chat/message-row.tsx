"use client";
/** One chat message, per the stitch mockup: assistant turns left with an
 *  icon-tile label + timestamp and a rich-markdown bubble (indigo headings,
 *  callouts, doc-citation links); user turns right-aligned in a solid
 *  indigo bubble. Memoized — typing in the composer must NOT re-run
 *  linkify + markdown + syntax-highlight for every rendered message. */
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  ArrowDownTrayIcon, BookmarkSquareIcon, SparklesIcon,
} from "@heroicons/react/24/outline";
import { clock } from "@/lib/format";
import type { LexHit, Msg } from "./types";

/** Build a linkifier with the citation targets precomputed + sorted ONCE —
 *  calling it per keystroke per message was the main typing-lag source. */
export function makeLinkifier(byPath: Map<string, LexHit[]>, byLeaf: Map<string, LexHit[]>, hints: Record<string, string[]>) {
  /** pick the right course when a filename exists in several: score hint
   *  tokens (from the course slug + its meeting titles) found in the text
   *  just before the citation — longer hits count more */
  const resolveHit = (cands: LexHit[], context: string): LexHit => {
    if (cands.length === 1) return cands[0]!;
    const ctx = context.toLowerCase().slice(-300);
    let best = cands[0]!;
    let bestScore = -1;
    for (const c of cands) {
      const score = (hints[c.course] ?? []).reduce((s, tok) => s + (ctx.includes(tok) ? tok.length : 0), 0);
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return best;
  };
  const linkFor = (leaf: string, hit: LexHit): string =>
    `[${leaf}](#doc:${encodeURIComponent(hit.course + "/" + hit.path)})`;
  // all known citations (full paths, bare leaves, and those without the
  // extension — the model often drops ".pdf"), longest first — a single
  // left-to-right scan never re-enters inserted link text, so a leaf that's
  // part of a longer path can't nest inside its own link
  const tset = new Map<string, LexHit[]>();
  const lset = new Map<string, LexHit[]>(); // lowercase name → cands
  const add = (name: string, cands: LexHit[]): void => {
    if (!name || name.length < 3 || tset.has(name)) return;
    tset.set(name, cands);
    const low = name.toLowerCase();
    if (low.length === name.length && !lset.has(low)) lset.set(low, cands);
  };
  for (const [p, c] of byPath) add(p, c);
  for (const [l, c] of byLeaf) add(l, c);
  // extension-less variants — only meaningful names, so ordinary words never
  // turn into stray links
  for (const name of [...tset.keys()]) {
    const stem = name.slice(0, name.lastIndexOf("."));
    if (stem.length >= 8) add(stem, tset.get(name)!);
  }
  const targets = [...tset].map(([name, cands]) => ({ name, lname: name.toLowerCase(), cands }))
    .sort((a, b) => b.name.length - a.name.length);
  // resolve a [[citation]] body: exact path/leaf, then stem, then case-insensitive
  const findCands = (raw: string): LexHit[] | undefined =>
    byPath.get(raw) ?? byLeaf.get(raw) ?? tset.get(raw) ?? lset.get(raw.toLowerCase());
  const linkifySegment = (seg: string): string => {
    const lseg = seg.toLowerCase();
    let out = "";
    let i = 0;
    while (i < seg.length) {
      // model citation syntax [[path]] → link when it resolves; unmatched
      // ones degrade to plain text (no stray brackets)
      if (seg.startsWith("[[", i)) {
        const end = seg.indexOf("]]", i + 2);
        if (end > 0) {
          const inner = seg.slice(i + 2, end).trim();
          const cands = findCands(inner);
          out += cands ? linkFor(inner, resolveHit(cands, seg.slice(0, i))) : inner;
          i = end + 2;
          continue;
        }
      }
      let hit = false;
      for (const t of targets) {
        if (seg.startsWith(t.name, i)) {
          out += linkFor(seg.slice(i, i + t.name.length), resolveHit(t.cands, seg.slice(0, i)));
          i += t.name.length;
          hit = true;
          break;
        }
        // case-insensitive fallback (length-preserving lowercasing only)
        if (t.lname.length === t.name.length && lseg.startsWith(t.lname, i)) {
          out += linkFor(seg.slice(i, i + t.name.length), resolveHit(t.cands, seg.slice(0, i)));
          i += t.name.length;
          hit = true;
          break;
        }
      }
      if (!hit) { out += seg[i]!; i++; }
    }
    return out;
  };
  return (md: string): string => md
    .split(/(`+[^`\n]+`+)/g)
    .map((seg, i) => {
      if (i % 2 === 0) return linkifySegment(seg);
      const inner = seg.replace(/^`+|`+$/g, "");
      const direct = findCands(inner);
      if (direct) return linkFor(inner, resolveHit(direct, seg));
      // cited as a code span WITH its folder path — match on the basename,
      // but only when a known hit actually lives at that path
      if (inner.includes("/")) {
        const base = inner.slice(inner.lastIndexOf("/") + 1);
        const bc = byLeaf.get(base);
        if (bc?.some((h) => h.path === inner)) return linkFor(inner, resolveHit(bc, seg));
      }
      return seg;
    })
    .join("");
}

export const MessageRow = memo(function MessageRow({ m, linkify, onOpenPreview, onSave, onDownload }: {
  m: Msg;
  linkify: (md: string) => string;
  onOpenPreview: (hash: string) => void;
  /** save this answer as a course material (course chat only) */
  onSave?: (content: string) => void;
  /** download this answer as a .md file */
  onDownload?: (content: string) => void;
}) {
  // linkified markdown computed once per message content
  const body = useMemo(() => linkify(m.content), [linkify, m.content]);
  // stable renderer config — a fresh object every render defeats memo downstream
  const mdComponents = useMemo(() => ({
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => href?.startsWith("#doc:") ? (
      <a href="#" onClick={(e) => { e.preventDefault(); onOpenPreview(href); }} className="chat-cite">{children} 👁</a>
    ) : (
      <a href={href} target="_blank" rel="noreferrer">{children}</a>
    ),
  }), [onOpenPreview]);
  const actions = onSave || onDownload;

  if (m.role === "user") {
    return (
      <article className="chat-turn chat-turn--user">
        <div className="chat-turn-meta">
          <span className="chat-turn-label">you</span>
          {m.at ? <span className="chat-turn-time">{clock(m.at)}</span> : null}
        </div>
        <div className="chat-bubble chat-bubble--user">
          <p>{m.content}</p>
        </div>
      </article>
    );
  }

  return (
    <article className="chat-turn chat-turn--assistant">
      <div className="chat-turn-meta">
        <span className="chat-turn-icon"><SparklesIcon className="heroicon" style={{ display: "inline" }} /></span>
        <span className="chat-turn-label">assistant</span>
        {m.at ? <span className="chat-turn-time">{clock(m.at)}</span> : null}
      </div>
      <div className="chat-bubble">
        <div className="chat-md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: false }]]}
            components={mdComponents}
          >{body}</ReactMarkdown>
        </div>
        {actions ? (
          <div className="chat-turn-actions">
            {onDownload && (
              <button type="button" className="chat-action" title="Download this answer as a Markdown file" onClick={() => onDownload(m.content)}>
                <ArrowDownTrayIcon className="heroicon" style={{ display: "inline", width: 13, height: 13 }} />
                .md
              </button>
            )}
            {onSave && (
              <button type="button" className="chat-action" title="Save this answer into Materials → Generated (indexed for future chats)" onClick={() => onSave(m.content)}>
                <BookmarkSquareIcon className="heroicon" style={{ display: "inline", width: 13, height: 13 }} />
                save as material
              </button>
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
});
