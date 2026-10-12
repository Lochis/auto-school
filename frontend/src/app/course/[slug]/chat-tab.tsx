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
  ArrowPathIcon, ArrowTopRightOnSquareIcon, ArrowUpIcon, BoltIcon, BookOpenIcon, ChevronDownIcon,
  GlobeAltIcon, PaperClipIcon, TrashIcon, XMarkIcon,
} from "@heroicons/react/24/outline";
import { LiveDot, MicroButton, Panel } from "@/components/ui";
import DocPreview from "@/components/chat/doc-preview";
import { MessageRow, makeLinkifier } from "@/components/chat/message-row";
import { SourceDocuments } from "@/components/chat/sidebar";
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
  const [srcOpen, setSrcOpen] = useState(false);
  // machine-extracted .index/ page cache: hidden by default, explicit toggle
  const [showIndexed, setShowIndexed] = useState(false);
  useEffect(() => { setShowIndexed(localStorage.getItem("askShowIndexed") === "1"); }, []);
  const toggleIndexed = (): void => {
    setShowIndexed((s) => { localStorage.setItem("askShowIndexed", s ? "0" : "1"); return !s; });
  };
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  useEffect(() => { setWebSearch(localStorage.getItem("askWebSearch") === "1"); }, []);
  const toggleWeb = (): void => {
    setWebSearch((w) => { localStorage.setItem("askWebSearch", w ? "0" : "1"); return !w; });
  };
  const [err, setErr] = useState("");
  const [note, setNote] = useState(""); // transient confirmations ("saved to …")
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(""), 6000);
    return () => clearTimeout(t);
  }, [note]);
  const [preview, setPreview] = useState<{ course: string; path: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  /** materials list — reloaded after saves/generations too */
  const reloadMaterials = useCallback((): void => {
    if (!slug) return;
    fetch(`/api/courses/${encodeURIComponent(slug)}/materials${showIndexed ? "?indexed=1" : ""}`)
      .then((r) => r.json())
      .then((j: { materials?: MaterialEntry[] }) => setMaterials(j.materials ?? []))
      .catch(() => { /* linkify just won't activate */ });
  }, [slug, showIndexed]);

  useEffect(() => {
    const chatUrl = slug ? `/api/courses/${encodeURIComponent(slug)}/chat` : "/api/chat";
    fetch(chatUrl)
      .then((r) => r.json())
      .then((j: { messages?: Msg[] }) => setMessages(j.messages ?? []))
      .catch(() => setErr("backend unreachable"));
    if (slug) {
      reloadMaterials();
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
  }, [slug, reloadMaterials]);

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

  // ── save / download assistant answers ──────────────────────────────
  /** download an assistant answer as .md — pure client-side, no backend */
  const downloadMd = useCallback((content: string): void => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
    a.download = `auto-school-answer-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

  /** save an assistant answer into Materials → Generated (indexed for Ask) */
  const saveAsMaterial = useCallback(async (content: string): Promise<void> => {
    if (!slug) return;
    const name = prompt("Save as material — file name:", `AI answer ${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    try {
      const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/materials/generated`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, markdown: content }),
      });
      const j = (await r.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!r.ok) setErr(j.error ?? `HTTP ${r.status}`);
      else {
        setNote(`saved to Materials → ${j.path}`);
        reloadMaterials();
      }
    } catch { setErr("save failed — backend unreachable"); }
  }, [slug, reloadMaterials]);
  /** stable wrappers — MessageRow is memoized */
  const handleSave = useCallback((c: string): void => { void saveAsMaterial(c); }, [saveAsMaterial]);

  // ── study sheets (AI cheat sheets under Generated/) ───────────────
  const [sheetOpen, setSheetOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState("");
  const sheets = useMemo(
    () => materials.filter((m) => m.path.startsWith("Generated/") && m.filename.startsWith("study-sheet-")),
    [materials],
  );

  const genSheet = async (regenPath?: string): Promise<void> => {
    if (!slug || sheetBusy) return;
    const t = topic.trim();
    if (!regenPath && !t) {
      setSheetErr("enter a topic first — e.g. \"Test 1\" or \"confusion matrices\"");
      return;
    }
    setSheetBusy(true);
    setSheetErr("");
    try {
      const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/study-sheet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regenPath ? { path: regenPath } : { topic: t }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; path?: string; pdf?: string | null; error?: string };
      if (!r.ok || !j.ok) setSheetErr(j.error ?? `HTTP ${r.status}`);
      else {
        setTopic("");
        setNote(`study sheet saved${j.pdf ? " (md + printable PDF)" : " (md — PDF skipped: a recording is live or the browser was busy)"}`);
        reloadMaterials();
      }
    } catch { setSheetErr("generation failed — is the daemon online?"); }
    finally { setSheetBusy(false); }
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

  // rough token estimate for the composer counter (≈ chars/4)
  const tokenEstimate = Math.ceil(input.length / 4);
  const suggestions = slug ? SUGGESTED_COURSE : SUGGESTED_ALL;

  return (
    <div className="chat-layout">
      {preview && <DocPreview slug={preview.course} path={preview.path} onClose={() => setPreview(null)} />}

      {/* ── left: conversational stream ── */}
      <section className="chat-main">
        {slug && (
          <div className="chat-src-head">
            <button
              type="button"
              className="chat-src-head-btn"
              onClick={() => setSrcOpen((o) => !o)}
              aria-expanded={srcOpen}
            >
              <BookOpenIcon className="heroicon" style={{ display: "inline", width: 16, height: 16 }} />
              <span>Source Documents</span>
              {materials.length > 0 && <span className="chat-token-count">{materials.length} Indexed</span>}
              <ChevronDownIcon className={`heroicon chat-src-chev ${srcOpen ? "chat-src-chev--open" : ""}`.trim()} style={{ display: "inline", width: 14, height: 14 }} />
            </button>
          </div>
        )}
        {slug && srcOpen && (
          <SourceDocuments slug={slug} materials={materials} onOpenPreview={openPreview} showIndexed={showIndexed} onToggleIndexed={toggleIndexed} />
        )}

        {/* study-sheet generator — collapsible, same pattern as Source Docs */}
        {slug && (
          <div className="chat-src-head">
            <button
              type="button"
              className="chat-src-head-btn"
              onClick={() => setSheetOpen((o) => !o)}
              aria-expanded={sheetOpen}
            >
              <BoltIcon className="heroicon" style={{ display: "inline", width: 16, height: 16 }} />
              <span>Study Sheets</span>
              {sheets.length > 0 && <span className="chat-token-count">{sheets.length} generated</span>}
              <ChevronDownIcon className={`heroicon chat-src-chev ${sheetOpen ? "chat-src-chev--open" : ""}`.trim()} style={{ display: "inline", width: 14, height: 14 }} />
            </button>
          </div>
        )}
        {slug && sheetOpen && (
          <Panel icon={<BoltIcon className="heroicon" />} title="Generate a cheat sheet">
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="chat-sheet-form">
                <input
                  className="chat-composer-input"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void genSheet(); }}
                  placeholder='topic — e.g. "Test 1" or "confusion matrices + regression"'
                  disabled={sheetBusy}
                />
                <button type="button" className="btn btn-primary" disabled={sheetBusy || !topic.trim()} onClick={() => void genSheet()}>
                  {sheetBusy ? "generating…" : "Generate"}
                </button>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: "0.8125rem" }}>
                Reads your materials + class notes, then writes a dense one-page cheat sheet into Materials → Generated (.md + printable PDF). Takes a minute or two.
              </p>
              {sheetBusy && (
                <p className="muted" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: "0.8125rem" }}>
                  <LiveDot static /> reading materials, writing the sheet — feel free to keep chatting…
                </p>
              )}
              {sheetErr && <p className="badge badge-red" style={{ margin: 0, alignSelf: "flex-start" }}>{sheetErr}</p>}
              {sheets.length > 0 && (
                <div className="chat-src-list">
                  {sheets.map((s) => {
                    const pdf = materials.find((m) => m.path === s.path.replace(/\.md$/, ".pdf"));
                    return (
                      <div key={s.path} className="chat-sheet-row">
                        <button type="button" className="chat-src-row" onClick={() => openPreview(slug, s.path)} title={`open ${s.path}`}>
                          <span className="chat-src-main">
                            <span className="icon-tile icon-tile--emerald"><BoltIcon className="heroicon" /></span>
                            <span style={{ minWidth: 0 }}>
                              <span className="chat-src-name">{s.filename.replace(/^study-sheet-/, "").replace(/\.md$/, "").replace(/-/g, " ")}</span>
                              <span className="chat-src-meta">{s.description || "AI study sheet"}</span>
                            </span>
                          </span>
                          <ArrowTopRightOnSquareIcon className="heroicon chat-src-open" />
                        </button>
                        <span className="chat-sheet-row-acts">
                          {pdf && (
                            <a
                              className="chat-action"
                              href={`/api/courses/${encodeURIComponent(slug)}/materials/download?p=${encodeURIComponent(pdf.path)}`}
                              title="download the printable PDF"
                            >
                              PDF
                            </a>
                          )}
                          <button type="button" className="chat-action" title="regenerate this sheet from the current materials" disabled={sheetBusy} onClick={() => void genSheet(s.path)}>
                            <ArrowPathIcon className="heroicon" style={{ display: "inline", width: 13, height: 13 }} />
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Panel>
        )}

        {/* thread */}
        <div className="chat-scroll">
          {messages.map((m) => (
            <MessageRow
              key={m.at ?? m.content.slice(0, 32)}
              m={m}
              linkify={linkify}
              onOpenPreview={openPreviewHash}
              onSave={slug ? handleSave : undefined}
              onDownload={downloadMd}
            />
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
        {note && <p className="muted" style={{ margin: 0, fontSize: "0.8125rem" }}>✓ {note}</p>}
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
              <button
                type="button"
                className="tool-chip"
                title="Attachments are not supported in chat — upload documents on the Materials tab; they are indexed for Ask automatically"
                aria-label="Add file (uploads are managed on the Materials tab)"
              >
                <PaperClipIcon className="heroicon" style={{ display: "inline", width: 14, height: 14 }} />
                Add file
              </button>
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
              <button
                type="button"
                className="tool-chip tool-chip--clear"
                onClick={() => void clear()}
                title="Clear this chat history"
              >
                <TrashIcon className="heroicon" style={{ display: "inline", width: 14, height: 14 }} />
                Clear
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
    </div>
  );
}
