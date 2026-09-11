"use client";
/** Notes/transcript panel that loads its markdown ON DEMAND — the course page
 *  used to SSR-render every session's full transcript (100KB+ each) into the
 *  HTML even though they sat in collapsed <details> (2s+ page loads).
 *  Fetches from /api/notes on first open; caches in state. */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

export default function LazyNotes({ course, stem, kind, title, eager = false }: { course: string; stem: string; kind: "notes" | "running" | "transcript"; title?: string; eager?: boolean }) {
  const [md, setMd] = useState<string | null>(eager ? "" : null); // "" = loading
  const [err, setErr] = useState("");
  const [fired, setFired] = useState(eager);

  const load = (): void => {
    if (fired) return;
    setFired(true);
    setMd("");
    fetch(`/api/notes?course=${encodeURIComponent(course)}&stem=${encodeURIComponent(stem)}&kind=${kind}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { markdown: string }) => setMd(j.markdown))
      .catch((e) => { setErr(String(e)); setMd(null); });
  };
  if (eager && fired && md === "") {
    // eager mode: kick off on first render (after paint via microtask)
    Promise.resolve().then(load);
  }

  return (
    <details style={{ marginTop: 10 }} open={eager || undefined} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) load(); }}>
      <summary>{title ?? "Notes"}</summary>
      <div className="notes">
        {err && <p className="err">{err}</p>}
        {md === "" && <p className="muted">loading…</p>}
        {md && (
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false }]]}>{md}</ReactMarkdown>
        )}
      </div>
    </details>
  );
}
