"use client";
/** Course "Ask" tab: chat with GLM about this course's materials + transcripts. */
import { useEffect, useRef, useState } from "react";

interface Msg { role: "user" | "assistant"; content: string; at: string }

export default function ChatTab({ slug }: { slug: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/courses/${encodeURIComponent(slug)}/chat`)
      .then((r) => r.json())
      .then((j: { messages?: Msg[] }) => setMessages(j.messages ?? []))
      .catch(() => setErr("backend unreachable"));
  }, [slug]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

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
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 4px" }}>
        {messages.length === 0 && (
          <div className="card" style={{ marginBottom: 8 }}>
            <p className="muted" style={{ margin: 0 }}>
              Ask anything about this course — “what do I need to know for week 1?”, “summarize the last lecture”,
              “what’s due next week?”. Answers use your uploaded materials and recorded transcripts.
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
            <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{m.content}</p>
          </div>
        ))}
        {busy && <p className="muted" style={{ margin: "4px 0" }}>thinking…</p>}
        {err && <p style={{ color: "#b91c1c", margin: "4px 0" }}>{err}</p>}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: "flex", gap: 8, paddingTop: 8, borderTop: "1px solid #e5e7eb" }}>
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
