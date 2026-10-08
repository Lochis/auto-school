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
import { SparklesIcon } from "@heroicons/react/24/outline";
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
  // all known citations (full paths + bare leaves), longest first — a
  // single left-to-right scan never re-enters inserted link text, so a
  // leaf that's part of a longer path can't nest inside its own link
  const targets = [...byPath, ...byLeaf].sort((a, b) => b[0].length - a[0].length);
  const linkifySegment = (seg: string): string => {
    let out = "";
    let i = 0;
    while (i < seg.length) {
      let hit = false;
      for (const [name, cands] of targets) {
        if (name && seg.startsWith(name, i)) {
          out += linkFor(name, resolveHit(cands, seg.slice(0, i)));
          i += name.length;
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
      const direct = byPath.get(inner) ?? byLeaf.get(inner);
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

export const MessageRow = memo(function MessageRow({ m, linkify, onOpenPreview }: { m: Msg; linkify: (md: string) => string; onOpenPreview: (hash: string) => void }) {
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
      </div>
    </article>
  );
});
