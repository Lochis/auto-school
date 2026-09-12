"use client";
/** Course "Ask" tab: chat with the LLM about this course — tool-calling on
 *  the backend (materials, document bundles, VLM page vision, transcripts).
 *  Assistant messages render as markdown; any material file name it cites
 *  becomes a link that opens an inline previewer. */
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface Msg { role: "user" | "assistant"; content: string; at: string }
interface Material { path: string; filename: string }
interface LexHit { course: string; path: string }


/** overlay: fixed, click-outside to close */
function DocPreview({ slug, path, onClose }: { slug: string; path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [twin, setTwin] = useState<string | null>(null); // docx→pdf twin, if converted
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const media = `/api/media/courses/${encodeURIComponent(slug)}/materials/${path.split("/").map(encodeURIComponent).join("/")}`;
  // bundle twin: .index/<rel-minus-ext>/source.pdf (proactive docx→pdf pass)
  const twinUrl = ext === "docx"
    ? `/api/media/courses/${encodeURIComponent(slug)}/materials/.index/${path.replace(/\.docx$/i, "").split("/").map(encodeURIComponent).join("/")}/source.pdf`
    : null;

  useEffect(() => {
    let alive = true;
    if (ext === "pdf" || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return; // rendered natively
    if (ext === "docx" && twinUrl) {
      // prefer the PDF twin for viewing; fall back to text if not converted yet
      fetch(twinUrl, { method: "HEAD" })
        .then((r) => {
          if (!alive) return;
          if (r.ok) { setTwin(twinUrl); return; }
          setTwin("none");
          return fetch(`/api/courses/${encodeURIComponent(slug)}/doc?path=${encodeURIComponent(path)}`)
            .then((r2) => r2.json())
            .then((j) => { if (alive) setText(j.error ? `⚠️ ${j.error}` : (j.text || "(empty)")); });
        })
        .catch(() => {
          if (!alive) return;
          setTwin("none");
          fetch(`/api/courses/${encodeURIComponent(slug)}/doc?path=${encodeURIComponent(path)}`)
            .then((r2) => r2.json())
            .then((j) => { if (alive) setText(j.error ? `⚠️ ${j.error}` : (j.text || "(empty)")); })
            .catch(() => { if (alive) setText("preview unavailable"); });
        });
      return;
    }
    fetch(`/api/courses/${encodeURIComponent(slug)}/doc?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((j) => { if (alive) setText(j.error ? `⚠️ ${j.error}` : (j.text || "(empty)")); })
      .catch(() => { if (alive) setText("preview unavailable"); });
    return () => { alive = false; };
  }, [slug, path, ext, twinUrl]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(900px, 94vw)", height: "86vh", display: "flex", flexDirection: "column", padding: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path}</strong>
          <span style={{ flex: 1 }} />
          <a href={media} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>open raw ↗</a>
          <button onClick={onClose}>✕ close</button>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {ext === "pdf" || twin?.startsWith("/") ? (
            <iframe src={twin?.startsWith("/") ? twin : media} title={path} style={{ width: "100%", height: "100%", border: 0, background: "#fff", borderRadius: 8 }} />
          ) : ["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media} alt={path} style={{ maxWidth: "100%", display: "block", margin: "0 auto" }} />
          ) : (
            <div className="notes" style={{ fontSize: 14 }}>
              {ext === "docx" && twin === null ? <p className="muted">checking for PDF twin…</p> : null}
              {text === null && !(ext === "docx" && twin === null) ? <p className="muted">extracting text…</p> : null}
              {text !== null ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChatTab({ slug, initialPrompt }: { slug?: string; initialPrompt?: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [lexicon, setLexicon] = useState<Record<string, LexHit[]>>({});
  const [hints, setHints] = useState<Record<string, string[]>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState<{ course: string; path: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const chatUrl = slug ? `/api/courses/${encodeURIComponent(slug)}/chat` : "/api/chat";
    fetch(chatUrl)
      .then((r) => r.json())
      .then((j: { messages?: Msg[] }) => setMessages(j.messages ?? []))
      .catch(() => setErr("backend unreachable"));
    if (slug) {
      fetch(`/api/courses/${encodeURIComponent(slug)}/materials`)
        .then((r) => r.json())
        .then((j: { materials?: Material[] }) => setMaterials(j.materials ?? []))
        .catch(() => { /* linkify just won't activate */ });
    } else {
      // all-courses chat: leaf filename → candidate courses for the linkifier
      fetch("/api/chat/lexicon")
        .then((r) => r.json())
        .then((j: { lexicon?: Record<string, LexHit[]>; hints?: Record<string, string[]> }) => {
          setLexicon(j.lexicon ?? {});
          setHints(j.hints ?? {});
        })
        .catch(() => { /* linkify just won't activate */ });
    }
  }, [slug]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  /** leaf filename → candidate {course, path} hits */
  const byLeaf = useMemo(() => {
    const m = new Map<string, LexHit[]>();
    if (slug) {
      for (const mat of materials) if (!m.has(mat.filename)) m.set(mat.filename, [{ course: slug, path: mat.path }]);
    } else {
      for (const [leaf, hits] of Object.entries(lexicon)) m.set(leaf, hits);
    }
    return m;
  }, [slug, materials, lexicon]);

  /** full material path ("Week 1/Week1 - exercise 1.pdf") → hits — the model
   *  cites paths this way when it echoes list_materials output verbatim */
  const byPath = useMemo(() => {
    const m = new Map<string, LexHit[]>();
    if (slug) {
      for (const mat of materials) m.set(mat.path, [{ course: slug, path: mat.path }]);
    } else {
      for (const hits of Object.values(lexicon)) for (const h of hits) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    }
    return m;
  }, [slug, materials, lexicon]);

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

  /** wrap known file names in markdown links pointing at the previewer.
   *  Code spans are protected (markdown inside them renders literally) — but
   *  a code span containing EXACTLY a known filename is the model citing it,
   *  so it becomes a link too. */
  const linkify = (md: string): string => {
    const linkifySegment = (seg: string): string => {
      // all known citations (full paths + bare leaves), longest first — a
      // single left-to-right scan never re-enters inserted link text, so a
      // leaf that's part of a longer path can't nest inside its own link
      const targets = [...byPath, ...byLeaf].sort((a, b) => b[0].length - a[0].length);
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
    return md
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
  };

  const send = async (override?: string): Promise<void> => {
    const message = (override ?? input).trim();
    if (!message || busy) return;
    setInput("");
    setErr("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: message, at: new Date().toISOString() }]);
    try {
      const r = await fetch(slug ? `/api/courses/${encodeURIComponent(slug)}/chat` : "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const j = (await r.json().catch(() => ({}))) as { reply?: string; error?: string };
      if (!r.ok || !j.reply) setErr(j.error ?? `HTTP ${r.status}`);
      else {
        setMessages((m) => [...m, { role: "assistant", content: j.reply!, at: new Date().toISOString() }]);
      }
    } catch { setErr("request failed"); }
    finally { setBusy(false); }
  };

  const clear = async (): Promise<void> => {
    if (!confirm("Clear this chat history?")) return;
    await fetch(slug ? `/api/courses/${encodeURIComponent(slug)}/chat` : "/api/chat", { method: "DELETE" }).catch(() => {});
    setMessages([]);
  };

  const openPreview = (hash: string): void => {
    const raw = decodeURIComponent(hash.slice(5));
    const sep = raw.indexOf("/");
    if (sep < 0) return;
    setPreview({ course: raw.slice(0, sep), path: raw.slice(sep + 1) });
  };

  // auto-send once when navigated here with ?prompt=… (deadline "ask AI" links)
  const lastSent = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (initialPrompt && lastSent.current !== initialPrompt) {
      lastSent.current = initialPrompt;
      void send(initialPrompt);
      // consume the prompt from the URL — reloads/back-nav must NOT re-send;
      // it lives on in the chat history anyway
      const u = new URL(window.location.href);
      if (u.searchParams.has("prompt")) {
        u.searchParams.delete("prompt");
        window.history.replaceState(null, "", u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : ""));
      }
    }
  }, [initialPrompt]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "70vh" }}>
      {preview && <DocPreview slug={preview.course} path={preview.path} onClose={() => setPreview(null)} />}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 4px" }}>
        {messages.length === 0 && (
          <div className="card" style={{ marginBottom: 8 }}>
            <p className="muted" style={{ margin: 0 }}>
              {slug ? (
                <>Ask anything about this course — “what do I need to do for week 1?”, “summarize the last lecture”,
              “explain the diagram in 1.1 Dimensional Modeling”. The assistant reads the actual documents
              (including figures, via a vision model) and recorded sessions.</>
              ) : (
                <>Ask across ALL courses — “it's week 1, what do I have to do and what should I study?”,
              “when is my next thing due?”, “which lectures covered dimensional modeling?”. The assistant
              sweeps every course's materials, sessions and documents (figures included, via a vision model).</>
              )}
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className="card" style={{
            marginBottom: 8,
            marginLeft: m.role === "user" ? "18%" : 0,
            marginRight: m.role === "assistant" ? "12%" : 0,
            background: m.role === "user" ? "#223049" : undefined,
          }}>
            <strong style={{ fontSize: 12, color: m.role === "user" ? "#2563eb" : "#059669" }}>
              {m.role === "user" ? "you" : "assistant"}
            </strong>
            {m.role === "assistant" ? (
              <div className="notes" style={{ marginTop: 4, fontSize: 14 }}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[[rehypeHighlight, { detect: false }]]}
                  components={{
                    a: ({ href, children }) => href?.startsWith("#doc:") ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); openPreview(href); }}
                         style={{ color: "#7dc4ff", textDecoration: "underline dotted" }}>{children} 👁</a>
                    ) : (
                      <a href={href} target="_blank" rel="noreferrer">{children}</a>
                    ),
                  }}
                >{linkify(m.content)}</ReactMarkdown>
              </div>
            ) : (
              <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{m.content}</p>
            )}
          </div>
        ))}
        {busy && <p className="muted" style={{ margin: "4px 0" }}>thinking (may read documents / view pages)…</p>}
        {err && <p style={{ color: "#b91c1c", margin: "4px 0" }}>{err}</p>}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: "flex", gap: 8, paddingTop: 8, borderTop: "1px solid #333" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={slug ? "ask about this course…" : "ask across all courses…"}
          style={{ flex: 1 }}
          disabled={busy}
        />
        <button onClick={() => void send()} disabled={busy || !input.trim()}>Send</button>
        <button onClick={() => void clear()} title="Clear chat history">🗑</button>
      </div>
    </div>
  );
}
