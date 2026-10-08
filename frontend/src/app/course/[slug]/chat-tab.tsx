"use client";
/** Course "Ask" tab: chat with the LLM about this course — tool-calling on
 *  the backend (materials, document bundles, VLM page vision, transcripts).
 *  Restyled per stitch/course_ai_assistant_knowledge_chat: context strip
 *  with indexed-material chips + current model, rich-markdown assistant
 *  turns with doc-citation links, indigo user bubbles, quoted suggested
 *  prompts, a composer dock (token estimate, Web toggle, emerald Send),
 *  and a right rail with Source Documents + the Next Deliverable widget.
 *  The same component also serves the all-courses chat (no slug → no rail). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpIcon, GlobeAltIcon, PaperClipIcon, TrashIcon, XMarkIcon,
} from "@heroicons/react/24/outline";
import { LiveDot, MicroButton } from "@/components/ui";
import DocPreview from "@/components/chat/doc-preview";
import { MessageRow, makeLinkifier } from "@/components/chat/message-row";
import ChatSidebar from "@/components/chat/sidebar";
import type { LexHit, MaterialEntry, Msg } from "@/components/chat/types";
import "../../chat-ui.css";

/** sensible static starters — the chat API has no suggestions endpoint */
const SUGGESTED_COURSE = [
  "Summarize the most recent lecture",
  "What's due next in this course?",
  "Quiz me on this week's material",
];
const SUGGESTED_ALL = [
  "What do I have to do this week across all courses?",
  "When is my next deadline?",
  "Which lectures covered the last assignment's topic?",
];

export default function ChatTab({ slug, initialPrompt }: { slug?: string; initialPrompt?: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [materials, setMaterials] = useState<MaterialEntry[]>([]);
  const [lexicon, setLexicon] = useState<Record<string, LexHit[]>>({});
  const [hints, setHints] = useState<Record<string, string[]>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  useEffect(() => { setWebSearch(localStorage.getItem("askWebSearch") === "1"); }, []);
  const toggleWeb = (): void => {
    setWebSearch((w) => { localStorage.setItem("askWebSearch", w ? "0" : "1"); return !w; });
  };
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
        .then((j: { materials?: MaterialEntry[] }) => setMaterials(j.materials ?? []))
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

  /** linkifier built ONCE per materials/lexicon load (targets precomputed
   *  + sorted) — not per message per render */
  const linkify = useMemo(() => makeLinkifier(byPath, byLeaf, hints), [byPath, byLeaf, hints]);

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
        body: JSON.stringify({ message, webSearch }),
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

  const openPreview = useCallback((course: string, path: string): void => {
    setPreview({ course, path });
  }, []);
  /** citation-link handler: "#doc:<encoded course>/<path>" → preview */
  const openPreviewHash = useCallback((hash: string): void => {
    const raw = decodeURIComponent(hash.slice(5));
    const sep = raw.indexOf("/");
    if (sep < 0) return;
    setPreview({ course: raw.slice(0, sep), path: raw.slice(sep + 1) });
  }, []);

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

  // context-strip chips: newest materials first
  const ctxChips = useMemo(
    () => [...materials].sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? "")),
    [materials],
  );
  const shownChips = ctxChips.slice(0, 3);
  const moreChips = ctxChips.length - shownChips.length;

  // rough token estimate for the composer counter (≈ chars/4)
  const tokenEstimate = Math.ceil(input.length / 4);
  // chat runs through the daemon's GLM routing (glmChatRaw, GLM_MODEL default glm-5.3)
  const modelName = "glm-5.3";

  const suggestions = slug ? SUGGESTED_COURSE : SUGGESTED_ALL;

  return (
    <div className={`chat-layout ${slug ? "chat-layout--with-rail" : ""}`.trim()}>
      {preview && <DocPreview slug={preview.course} path={preview.path} onClose={() => setPreview(null)} />}

      {/* ── left: conversational stream ── */}
      <section className="chat-main">
        {/* context strip */}
        <div className="chat-ctx">
          <div className="chat-ctx-chips">
            <LiveDot />
            <span className="chat-ctx-label">Context loaded:</span>
            {slug ? (
              <>
                {shownChips.map((m) => (
                  <button key={m.path} type="button" className="chat-ctx-chip" title={`open ${m.path}`} onClick={() => openPreview(slug, m.path)}>
                    {m.filename}
                  </button>
                ))}
                {moreChips > 0 && <span className="chip chip--pill">+{moreChips} more</span>}
                {ctxChips.length === 0 && <span className="chat-ctx-label" style={{ color: "var(--outline)" }}>no materials indexed yet</span>}
              </>
            ) : (
              <span className="chat-ctx-label">every registered course — materials, sessions &amp; documents</span>
            )}
          </div>
          <div className="chat-ctx-right">
            <MicroButton
              onClick={() => void clear()}
              title="Clear this chat history"
              icon={<TrashIcon className="heroicon" style={{ width: 12, height: 12 }} />}
            >
              clear
            </MicroButton>
            <span className="chat-ctx-model" title="head of the model fallback chain (Settings)">
              Model: {modelName}
            </span>
          </div>
        </div>

        {/* thread */}
        <div className="chat-scroll">
          {messages.map((m) => (
            <MessageRow key={m.at ?? m.content.slice(0, 32)} m={m} linkify={linkify} onOpenPreview={openPreviewHash} />
          ))}
          {busy && (
            <p className="muted" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: "0.8125rem" }}>
              <LiveDot static /> thinking (may read documents / view pages{webSearch ? " / search the web" : ""})…
            </p>
          )}
          {err && (
            <p className="badge badge-red" style={{ alignSelf: "flex-start" }}>{err}</p>
          )}
          <div ref={bottomRef} />
        </div>

        {/* suggested starters — always available just above the composer */}
        <div className="chat-suggest-row">
          <span className="chat-suggest-hint">Try:</span>
          {suggestions.map((x) => (
            <button key={x} type="button" className="chat-suggest-btn" disabled={busy} onClick={() => void send(`"${x}"`)}>{`“${x}”`}</button>
          ))}
        </div>

        {/* composer dock */}
        <form
          className="chat-composer"
          onSubmit={(e) => { e.preventDefault(); void send(); }}
        >
          <div className="chat-composer-row">
            <input
              className="chat-composer-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={slug ? "ask about this course…" : "ask across all courses…"}
              disabled={busy}
            />
            {input && (
              <button type="button" className="chat-composer-clear" title="Clear input" onClick={() => setInput("")}>
                <XMarkIcon className="heroicon" style={{ display: "inline", width: 14, height: 14 }} />
              </button>
            )}
          </div>
          <div className="chat-composer-foot">
            <div className="chat-composer-tools">
              <MicroButton
                type="button"
                icon={<PaperClipIcon className="heroicon" style={{ display: "inline", width: 14, height: 14 }} />}
                title="Attachments are not supported here — upload documents on the Materials tab; they are indexed for Ask automatically"
                aria-label="Add file (uploads are managed on the Materials tab)"
              >
                Add file
              </MicroButton>
              <button
                type="button"
                className={`chat-web-btn ${webSearch ? "chat-web-btn--on" : ""}`.trim()}
                onClick={toggleWeb}
                title={webSearch
                  ? "Web search ON — the assistant may also search the public web for background (course materials still take priority)"
                  : "Web search OFF — only course materials are used as context"}
              >
                <GlobeAltIcon className="heroicon" style={{ display: "inline", width: 14, height: 14 }} />
                Web {webSearch ? "on" : "off"}
              </button>
              <span className="chat-token-count" title="rough estimate of the outgoing prompt size">
                tokens: {tokenEstimate.toLocaleString("en-US")} / 128k
              </span>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()} title="Send (Enter)">
              Send <ArrowUpIcon className="heroicon" style={{ display: "inline" }} />
            </button>
          </div>
        </form>
      </section>

      {/* ── right: knowledge rail (course chat only) ── */}
      {slug && <ChatSidebar slug={slug} materials={materials} onOpenPreview={openPreview} />}
    </div>
  );
}
