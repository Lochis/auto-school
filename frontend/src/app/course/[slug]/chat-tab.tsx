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
  GlobeAltIcon, PaperClipIcon, StopIcon, TrashIcon, XMarkIcon,
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
  const abortRef = useRef<AbortController | null>(null); // Stop button: cancels the in-flight stream
  const abort = (): void => { abortRef.current?.abort(); };
  const [webSearch, setWebSearch] = useState(false);
  useEffect(() => { setWebSearch(localStorage.getItem("askWebSearch") === "1"); }, []);
  const toggleWeb = (): void => {
    setWebSearch((w) => { localStorage.setItem("askWebSearch", w ? "0" : "1"); return !w; });
  };
  const [err, setErr] = useState("");
  const [status, setStatus] = useState(""); // live tool status while a streamed answer is being built
  // gathering vs writing: streamed text that hasn't been committed by {done}
  // is a DRAFT (the model often writes a full-looking answer, then calls more
  // tools — that text is preface, not the answer). Drafts render dimmed under
  // the status line; wiped prefaces become one-line "thoughts". Only {done}
  // (or a Stop-press/cancel with partial text) writes into the message bubble
  // — so a question always ends with exactly ONE answer, never rewrites.
  const [draft, setDraft] = useState("");
  const [gathered, setGathered] = useState<string[]>([]);
  // context divider info from the server: which history messages the model
  // actually sees (token-budget window + pinned jumbo pastes). null = all in.
  const [ctxInfo, setCtxInfo] = useState<{ keptFrom: number; pinned: number[] } | null>(null);
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
      .then((j: { messages?: Msg[]; ctx?: { keptFrom: number; pinned: number[] } }) => {
        setMessages(j.messages ?? []);
        setCtxInfo(j.ctx ?? null);
      })
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
    bottomRef.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth" }); // instant while tokens stream in
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

  /** patch the streaming assistant message (always the last one) */
  const patchAssistant = (fn: (prev: string) => string): void => {
    setMessages((ms) => {
      if (!ms.length || ms[ms.length - 1]!.role !== "assistant") return ms;
      const last = ms.length - 1;
      const copy = [...ms];
      copy[last] = { ...copy[last]!, content: fn(copy[last]!.content) };
      return copy;
    });
  };

  const send = async (override?: string): Promise<void> => {
    const message = (override ?? input).trim();
    if (!message || busy) return;
    setInput("");
    setErr("");
    setStatus("");
    setBusy(true);
    setMessages((m) => [
      ...m,
      { role: "user", content: message, at: new Date().toISOString() },
      { role: "assistant", content: "", at: new Date().toISOString() }, // streaming placeholder
    ]);
    const dropPlaceholder = (): void => setMessages((m) => m.slice(0, -1));
    const ac = new AbortController();
    abortRef.current = ac;
    // hoisted so the abort/cancel path can commit a partial draft
    let draftLocal = "";
    try {
      const r = await fetch(slug ? `/api/courses/${encodeURIComponent(slug)}/chat` : "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, webSearch }),
        signal: ac.signal,
      });
      if (!r.ok || !r.body) {
        // plain-JSON error — the backend never started the SSE stream
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? `HTTP ${r.status}`);
        dropPlaceholder();
        return;
      }
      // SSE: {status} tool progress → {delta} draft tokens → {reset} draft was
      // preface, archive it → {done} commits the single authoritative answer
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let errored = false;
      let gatheredLocal: string[] = [];
      const sync = (): void => { setDraft(draftLocal); setGathered([...gatheredLocal]); };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev: { type?: string; text?: string; reply?: string; error?: string; keptFrom?: number; pinned?: number[] };
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === "delta" && ev.text) { draftLocal += ev.text!; sync(); }
          else if (ev.type === "reset") { // that text was tool-preface, not the answer — archive, don't display-as-answer
            if (draftLocal.trim()) gatheredLocal = [...gatheredLocal.slice(-4), draftLocal.trim()];
            draftLocal = "";
            sync();
          }
          else if (ev.type === "status" && ev.text) setStatus(ev.text);
          else if (ev.type === "done" && typeof ev.reply === "string") {
            patchAssistant(() => ev.reply!); // authoritative full text — the one commit
            draftLocal = ""; gatheredLocal = []; sync();
          }
          else if (ev.type === "error") { setErr(ev.error ?? "chat failed"); errored = true; }
          else if (ev.type === "ctx") setCtxInfo({ keptFrom: ev.keptFrom ?? 0, pinned: ev.pinned ?? [] });
        }
      }
      // stream ended without {done} (e.g. server closed early): commit what we
      // have rather than losing it — matches the old partial-keeping behavior
      if (!errored && draftLocal.trim()) patchAssistant(() => draftLocal.trim());
      if (errored) dropPlaceholder();
    } catch (e) {
      if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        // Stop pressed: commit whatever draft had streamed, then keep the
        // bubble only if something landed
        if (draftLocal.trim()) patchAssistant(() => draftLocal.trim());
        setMessages((m) => (m.length > 0 && m[m.length - 1]!.role === "assistant" && !m[m.length - 1]!.content ? m.slice(0, -1) : m));
      } else {
        setErr("request failed");
        dropPlaceholder();
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStatus("");
      setDraft("");
      setGathered([]);
    }
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
      {preview && <DocPreview slug={preview.course} path={preview.path} linkify={linkify} onOpenPreview={openPreviewHash} onClose={() => setPreview(null)} />}

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
          {messages.map((m, i) => {
            // streaming placeholder: invisible until its first token lands —
            // only the status line shows while the model is still exploring
            if (busy && i === messages.length - 1 && m.role === "assistant" && !m.content) return null;
            // context zones: pinned jumbos (above the window, always seen by
            // the model), the live window, and dimmed out-of-context history
            const pinned = ctxInfo?.pinned.includes(i) ?? false;
            const inCtx = !ctxInfo || i >= ctxInfo.keptFrom || pinned;
            return (
              <div key={m.at ? `${i}-${m.at}` : i} style={inCtx ? undefined : { opacity: 0.45 }} title={inCtx ? undefined : "outside the model's context window for new replies"}>
                {ctxInfo && i === ctxInfo.keptFrom && i > 0 && (
                  <div className="muted" style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0", fontSize: "0.75rem" }}>
                    <span style={{ flex: 1, height: 1, background: "currentColor", opacity: 0.25 }} />
                    the assistant sees this and below
                    <span style={{ flex: 1, height: 1, background: "currentColor", opacity: 0.25 }} />
                  </div>
                )}
                {pinned && (
                  <p className="muted" style={{ margin: "0 0 2px", fontSize: "0.7rem" }}>📌 your message — always in the assistant's context</p>
                )}
                <MessageRow
                  m={m}
                  linkify={linkify}
                  onOpenPreview={openPreviewHash}
                  onSave={slug ? handleSave : undefined}
                  onDownload={downloadMd}
                />
              </div>
            );
          })}
          {busy && messages.length > 0 && messages[messages.length - 1]!.role === "assistant" && !messages[messages.length - 1]!.content && (
            <p className="muted" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: "0.8125rem" }}>
              <LiveDot static /> {status || `thinking (may read documents / view pages${webSearch ? " / search the web" : ""})…`}
            </p>
          )}
          {/* gathering layer: archived prefaces (one-liners) + the live draft,
              both clearly NOT the answer — dimmed, below the status line.
              Vanishes when {done} commits the real answer. */}
          {busy && (gathered.length > 0 || draft) && (
            <div className="muted" style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "0.8125rem", margin: "4px 0 0 10px" }}>
              {gathered.map((g, i) => (
                <details key={i} style={{ margin: 0, opacity: 0.6, borderLeft: "2px solid currentColor", paddingLeft: 8 }}>
                  <summary style={{ cursor: "pointer", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    discarded draft ({g.length.toLocaleString()} chars){g.length > 160 ? ` — ${g.slice(0, 160)}…` : ""}
                  </summary>
                  <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{g}</p>
                </details>
              ))}
              {draft && (
                <p style={{ margin: 0, opacity: 0.75, borderLeft: "2px solid currentColor", paddingLeft: 8, whiteSpace: "pre-wrap" }}>
                  {draft}
                </p>
              )}
            </div>
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
          onSubmit={(e) => { e.preventDefault(); if (busy) abort(); else void send(); }}
        >
          {ctxInfo && ctxInfo.keptFrom > 0 && !busy && (
            <p className="muted" style={{ margin: "0 0 6px", fontSize: "0.75rem" }}>
              ⚠ The assistant only sees the conversation below the divider. Older replies aren't lost if you save them — 📖 <b>save as material</b> under a reply keeps it indexed and semantic-searchable in every future chat (chat history isn't).
            </p>
          )}
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
            <button type="submit" className="btn btn-primary" title={busy ? "Stop generating (keeps the partial answer)" : "Send (Enter)"}>
              {busy ? <><StopIcon className="heroicon" style={{ display: "inline" }} /> Stop</> : <>Send <ArrowUpIcon className="heroicon" style={{ display: "inline" }} /></>}
            </button>
          </div>
        </form>
      </section>

      {/* ── right: knowledge rail (course chat only) ── */}
    </div>
  );
}
