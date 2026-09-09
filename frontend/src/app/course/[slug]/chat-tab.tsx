"use client";
/** Course "Ask" tab: chat with the LLM about this course — tool-calling on
 *  the backend (materials, document bundles, VLM page vision, transcripts).
 *  Assistant messages render as markdown; any material file name it cites
 *  becomes a link that opens an inline previewer. */
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Msg { role: "user" | "assistant"; content: string; at: string }
interface Material { path: string; filename: string }

/** overlay: fixed, click-outside to close */
function DocPreview({ slug, path, onClose }: { slug: string; path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const media = `/api/media/courses/${encodeURIComponent(slug)}/materials/${path.split("/").map(encodeURIComponent).join("/")}`;

  useEffect(() => {
    if (ext === "pdf" || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return; // rendered natively
    let alive = true;
    fetch(`/api/courses/${encodeURIComponent(slug)}/doc?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((j) => { if (alive) setText(j.error ? `⚠️ ${j.error}` : (j.text || "(empty)")); })
      .catch(() => { if (alive) setText("preview unavailable"); });
    return () => { alive = false; };
  }, [slug, path, ext]);

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
          {ext === "pdf" ? (
            <iframe src={media} title={path} style={{ width: "100%", height: "100%", border: 0, background: "#fff", borderRadius: 8 }} />
          ) : ["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media} alt={path} style={{ maxWidth: "100%", display: "block", margin: "0 auto" }} />
          ) : (
            <div className="notes" style={{ fontSize: 14 }}>
              {text === null ? <p className="muted">extracting text…</p> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChatTab({ slug }: { slug: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/courses/${encodeURIComponent(slug)}/chat`)
      .then((r) => r.json())
      .then((j: { messages?: Msg[] }) => setMessages(j.messages ?? []))
      .catch(() => setErr("backend unreachable"));
    fetch(`/api/courses/${encodeURIComponent(slug)}/materials`)
      .then((r) => r.json())
      .then((j: { materials?: Material[] }) => setMaterials(j.materials ?? []))
      .catch(() => { /* linkify just won't activate */ });
  }, [slug]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  /** leaf filename → materials path (first hit wins) */
  const byLeaf = useMemo(() => {
    const m = new Map<string, string>();
    for (const mat of materials) if (!m.has(mat.filename)) m.set(mat.filename, mat.path);
    return m;
  }, [materials]);

  /** wrap known file names in markdown links pointing at the previewer */
  const linkify = (md: string): string => {
    let out = md;
    for (const [leaf, path] of byLeaf) {
      if (out.includes(leaf)) out = out.replaceAll(leaf, `[${leaf}](#doc:${encodeURIComponent(path)})`);
    }
    return out;
  };

  const send = async (): Promise<void> => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setErr("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: message, at: new Date().toISOString() }]);
    try {
      const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/chat`, {
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
    if (!confirm("Clear this course's chat history?")) return;
    await fetch(`/api/courses/${encodeURIComponent(slug)}/chat`, { method: "DELETE" }).catch(() => {});
    setMessages([]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "70vh" }}>
      {preview && <DocPreview slug={slug} path={preview} onClose={() => setPreview(null)} />}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 4px" }}>
        {messages.length === 0 && (
          <div className="card" style={{ marginBottom: 8 }}>
            <p className="muted" style={{ margin: 0 }}>
              Ask anything about this course — “what do I need to do for week 1?”, “summarize the last lecture”,
              “explain the diagram in 1.1 Dimensional Modeling”. The assistant reads the actual documents
              (including figures, via a vision model) and recorded sessions.
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
                  components={{
                    a: ({ href, children }) => href?.startsWith("#doc:") ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); setPreview(decodeURIComponent(href.slice(5))); }}
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
          placeholder="ask about this course…"
          style={{ flex: 1 }}
          disabled={busy}
        />
        <button onClick={() => void send()} disabled={busy || !input.trim()}>Send</button>
        <button onClick={() => void clear()} title="Clear chat history">🗑</button>
      </div>
    </div>
  );
}
