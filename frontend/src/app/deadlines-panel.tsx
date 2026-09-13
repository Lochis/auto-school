"use client";
/** Deadline calendar — AI-built from the real course files. Hard due dates
 *  grouped by urgency; "spread out" items get their own lane. Checked-off
 *  items persist across rebuilds (backend carries done-ness by course+title).
 *  Each row links into that course's chat with a task-specific starter
 *  prompt (guide-me-through for labs/assignments, study plan for exams). */
import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export interface DeadEntry {
  id: string;
  course: string;
  title: string;
  due: string | null;
  kind: string;
  spread: boolean;
  startBy: string | null;
  note: string;
  source: string;
  confidence: string;
  done?: boolean;
  doneAt?: number | null;
  userNote?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  doneAt?: number | null;
  manual?: boolean;
}
export interface Checklist {
  deadlineId: string;
  course: string;
  title: string;
  items: ChecklistItem[];
  updatedAt: number;
}

const KIND_ICON: Record<string, string> = {
  assignment: "📝", lab: "🔬", reading: "📖", install: "⬇️",
  signup: "👥", post: "💬", quiz: "❓", exam: "🎓", other: "📌",
};

function daysUntil(date: string): number {
  return Math.round((Date.parse(`${date}T12:00:00`) - Date.now()) / 86_400_000);
}
function fmtDue(date: string): string {
  const d = daysUntil(date);
  const when = d === 0 ? "today" : d === 1 ? "tomorrow" : d < 0 ? `${-d}d overdue` : d <= 7 ? `in ${d}d` : new Date(`${date}T12:00:00`).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  return `${date} (${when})`;
}

/** task-aware starter prompt for the course chat */
function starterPrompt(it: DeadEntry): string {
  const when = it.due ? ` due ${it.due}` : "";
  if (it.kind === "exam")
    return `Help me prepare for "${it.title}"${when}. First use your tools to find the relevant materials and recorded sessions for this course, list the key topics to study and which files cover them, then quiz me on the most important ones.`;
  if (it.kind === "lab" || it.kind === "assignment")
    return `Guide me through completing "${it.title}"${when}. Use your tools to find the task sheet/spec for it, summarize exactly what's required and what to submit, then walk me through it step by step.`;
  return `I need to do "${it.title}"${when}. Check the course materials with your tools, tell me exactly what's involved, and give me a short ordered checklist to get it done.`;
}

/** short course code from a slug — "26F-COMP303-Enterprise_App_Dev" → "COMP303" */
function courseCode(slug: string): string {
  return slug.match(/([A-Z]{2,4}\d{2,4})/)?.[1] ?? slug.split("-").slice(0, 2).join("-");
}

export default function DeadlinesPanel({ initial }: { initial: DeadEntry[] }) {
  const router = useRouter();
  const [items, setItems] = useState<DeadEntry[]>(initial);
  const [busy, setBusy] = useState<"" | "update" | "full">("");
  const [msg, setMsg] = useState("");
  const [toast, setToast] = useState<{ added: { course: string; title: string; due: string | null }[]; text: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 10_000);
    return () => clearTimeout(t);
  }, [toast]);
  const [tab, setTab] = useState<"week" | "later" | "done">("week");
  // ── per-deadline checklists ──
  const [cks, setCks] = useState<Record<string, Checklist>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState<Record<string, boolean>>({});
  const [ckMsg, setCkMsg] = useState<Record<string, string>>({});
  const [addText, setAddText] = useState<Record<string, string>>({});
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const [noteText, setNoteText] = useState<string>("");

  useEffect(() => setItems(initial), [initial]);

  const refreshCks = async (): Promise<void> => {
    try {
      const j = (await fetch("/api/checklists").then((r) => r.json())) as { checklists?: Checklist[] };
      if (j.checklists) setCks(Object.fromEntries(j.checklists.map((c) => [c.deadlineId, c])));
    } catch { /* leave state */ }
  };
  useEffect(() => { void refreshCks(); }, []);

  const postCk = async (body: Record<string, unknown>): Promise<void> => {
    const r = await fetch("/api/checklists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { checklists?: Checklist[]; error?: string };
    if (j.checklists) setCks(Object.fromEntries(j.checklists.map((c) => [c.deadlineId, c])));
    if (!r.ok) setCkMsg((m) => ({ ...m, [String(body.deadlineId)]: j.error ?? `HTTP ${r.status}` }));
  };

  const genCk = async (it: DeadEntry): Promise<void> => {
    setGenBusy((m) => ({ ...m, [it.id]: true }));
    setCkMsg((m) => ({ ...m, [it.id]: "" }));
    try {
      await postCk({ deadlineId: it.id });
      if (!cks[it.id]) await refreshCks(); // generate returns {ok,count} — pull the list
      setExpanded(it.id);
    } catch { setCkMsg((m) => ({ ...m, [it.id]: "backend unreachable" })); }
    finally { setGenBusy((m) => ({ ...m, [it.id]: false })); }
  };

  const rebuild = async (mode: "update" | "full"): Promise<void> => {
    setBusy(mode); setMsg(""); setToast(null);
    try {
      const r = await fetch("/api/deadlines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const j = (await r.json().catch(() => ({}))) as { count?: number; error?: string; added?: { course: string; title: string; due: string | null }[]; changed?: number; mode?: string };
      if (!r.ok) setMsg(j.error ?? `HTTP ${r.status}`);
      else {
        if (j.mode === "update") {
          setMsg(`updated — ${j.count} item(s), ${j.changed ?? 0} doc(s) scanned`);
          if (j.added?.length) setToast({ added: j.added, text: `${j.added.length} new deadline${j.added.length > 1 ? "s" : ""} added:` });
        } else setMsg(`built ${j.count} item(s)`);
        const lr = await fetch("/api/deadlines").then((x) => x.json()).catch(() => ({}) as { deadlines?: DeadEntry[] });
        if (lr.deadlines) setItems(lr.deadlines);
        router.refresh();
      }
    } catch { setMsg("rebuild failed — backend unreachable"); }
    finally { setBusy(""); }
  };

  const toggle = (id: string): void => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    // optimistic: flip immediately, move to Done visually
    setItems((m) => m.map((x) => (x.id === id ? { ...x, done: !x.done, doneAt: !x.done ? Date.now() : null } : x)));
    fetch("/api/deadlines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, done: !it.done }),
    }).then((r) => r.json())
      .then((j: { deadlines?: DeadEntry[] }) => { if (j.deadlines) setItems(j.deadlines); }) // server truth (IDs may have merged)
      .catch(() => { /* keep optimistic state */ });
  };

  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const dated = open.filter((i) => i.due).sort((a, b) => a.due!.localeCompare(b.due!));
  const overdue = dated.filter((i) => daysUntil(i.due!) < 0);
  const week = dated.filter((i) => daysUntil(i.due!) >= 0 && daysUntil(i.due!) <= 7);
  const later = dated.filter((i) => daysUntil(i.due!) > 7);
  const spread = open.filter((i) => !i.due && (i.spread || i.startBy));
  // spread items belong to This Week when their start-by date is near
  const spreadSoon = spread.filter((i) => !i.startBy || daysUntil(i.startBy) <= 7);
  const spreadFar = spread.filter((i) => i.startBy && daysUntil(i.startBy) > 7);
  const weekTab = [...overdue, ...week, ...spreadSoon];
  const laterTab = [...later, ...spreadFar];

  const saveNote = async (it: DeadEntry): Promise<void> => {
    const v = noteText.trim().slice(0, 2000);
    // optimistic
    setItems((m) => m.map((x) => (x.id === it.id ? { ...x, userNote: v || undefined } : x)));
    setNoteEdit(null);
    try {
      const r = await fetch("/api/deadlines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it.id, userNote: v }) });
      const j = (await r.json().catch(() => ({}))) as { deadlines?: DeadEntry[] };
      if (j.deadlines) setItems(j.deadlines); // server truth
    } catch { /* keep optimistic state */ }
  };

  const ChecklistBox = ({ it }: { it: DeadEntry }) => {
    const c = cks[it.id];
    if (!c) {
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0 2px 26px" }}>
          <button onClick={() => void genCk(it)} disabled={!!genBusy[it.id]}>
            {genBusy[it.id] ? "building… (reads the task sheet — can take a minute)" : "Generate checklist with AI"}
          </button>
          {ckMsg[it.id] && <span className="muted" style={{ fontSize: 12, color: "#f87171" }}>{ckMsg[it.id]}</span>}
        </div>
      );
    }
    const doneN = c.items.filter((x) => x.done).length;
    const pct = c.items.length ? Math.round((doneN / c.items.length) * 100) : 0;
    return (
      <div style={{ margin: "4px 0 6px 26px", padding: "6px 10px", borderLeft: "2px solid #7aa2f7", background: "rgba(122,162,247,0.06)", borderRadius: 4 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: doneN === c.items.length && c.items.length > 0 ? "#4ade80" : undefined }}>
            {doneN}/{c.items.length} steps{doneN === c.items.length && c.items.length > 0 ? " — done ✓" : ""}
          </span>
          <div style={{ width: 90, height: 5, borderRadius: 3, background: "#333", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: doneN === c.items.length ? "#4ade80" : "#7aa2f7" }} />
          </div>
          <button
            onClick={() => void genCk(it)} disabled={!!genBusy[it.id]} title="re-sweep the materials; checked steps stay checked"
            style={{ fontSize: 11, padding: "1px 7px" }}
          >
            {genBusy[it.id] ? "rebuilding…" : "↻ Regenerate"}
          </button>
          <button
            onClick={() => { void fetch(`/api/checklists?deadlineId=${encodeURIComponent(it.id)}`, { method: "DELETE" }).then(() => refreshCks()); }}
            title="delete this checklist (the deadline itself stays)"
            style={{ fontSize: 11, padding: "1px 7px" }}
          >
            ✕ remove
          </button>
          {ckMsg[it.id] && <span className="muted" style={{ fontSize: 12, color: "#f87171" }}>{ckMsg[it.id]}</span>}
        </div>
        {genBusy[it.id] && <p className="muted" style={{ margin: "2px 0 4px", fontSize: 12 }}>building… (reads the task sheet — can take a minute)</p>}
        {c.items.map((x) => (
          <div key={x.id} style={{ display: "flex", gap: 7, alignItems: "baseline", padding: "2px 0" }}>
            <input type="checkbox" checked={x.done} aria-label={x.text}
              onChange={() => {
                setCks((m) => ({ ...m, [it.id]: { ...c, items: c.items.map((y) => (y.id === x.id ? { ...y, done: !y.done, doneAt: !y.done ? Date.now() : null } : y)) } })); // optimistic
                void postCk({ deadlineId: it.id, itemId: x.id, done: !x.done });
              }}
              style={{ accentColor: "#7aa2f7", transform: "translateY(1px)" }}
            />
            <span style={{ fontSize: 13, textDecoration: x.done ? "line-through" : undefined, opacity: x.done ? 0.6 : 1 }}>{x.text}{x.manual ? " ✎" : ""}</span>
            <button onClick={() => void postCk({ deadlineId: it.id, removeItemId: x.id })} title="remove step" style={{ all: "unset", cursor: "pointer", fontSize: 11, color: "#888" }}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <input
            value={addText[it.id] ?? ""}
            onChange={(e) => setAddText((m) => ({ ...m, [it.id]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (addText[it.id] ?? "").trim()) {
                void postCk({ deadlineId: it.id, add: addText[it.id].trim() });
                setAddText((m) => ({ ...m, [it.id]: "" }));
              }
            }}
            placeholder="add a step yourself…"
            style={{ width: 300, fontSize: 12 }}
          />
        </div>
      </div>
    );
  };

  const Row = ({ it, hot }: { it: DeadEntry; hot?: boolean }) => {
    const ck = cks[it.id];
    const doneN = ck ? ck.items.filter((x) => x.done).length : 0;
    return (
      <>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0", flexWrap: "wrap" }}>
          <input type="checkbox" checked={!!it.done} onChange={() => toggle(it.id)} style={{ accentColor: "#4ade80", transform: "translateY(1px)" }} aria-label={`mark ${it.title} done`} />
          <span style={{ fontSize: 13 }}>{KIND_ICON[it.kind] ?? "📌"}</span>
          <span className="muted" style={{ fontSize: 12, minWidth: 120 }}>{it.due ? fmtDue(it.due) : it.startBy ? `start by ${it.startBy}` : "no date"}</span>
          <Link href={`/course/${encodeURIComponent(it.course)}`} title={it.course} style={{ fontSize: 11, color: "#94a3b8", border: "1px solid #444", borderRadius: 4, padding: "0 5px", textDecoration: "none" }}>{courseCode(it.course)}</Link>
          <span style={{ fontSize: 14, color: hot ? "#f87171" : undefined, fontWeight: hot ? 600 : undefined, textDecoration: it.done ? "line-through" : undefined }}>{it.title}</span>
          {ck && (
            <button onClick={() => setExpanded(expanded === it.id ? null : it.id)} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: doneN === ck.items.length && ck.items.length > 0 ? "#4ade80" : "#7aa2f7" }} title="show checklist">
              ✓ {doneN}/{ck.items.length}{expanded === it.id ? " ▴" : " ▾"}
            </button>
          )}
          <Link href={`/course/${encodeURIComponent(it.course)}?tab=ask&prompt=${encodeURIComponent(starterPrompt(it))}`} style={{ fontSize: 12 }}>ask AI ↗</Link>
          {!ck && !genBusy[it.id] && (
            <button onClick={() => { setExpanded(it.id); void genCk(it); }} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: "#7aa2f7" }} title="AI-generate an execution checklist for this task">✚ checklist</button>
          )}
          {genBusy[it.id] && <span className="muted" style={{ fontSize: 11 }}>building checklist…</span>}
          <button
            onClick={() => { setNoteEdit(noteEdit === it.id ? null : it.id); setNoteText(it.userNote ?? ""); }}
            title="add your own context — group members, roles, links… (shown to the AI and kept across rebuilds)"
            style={{ all: "unset", cursor: "pointer", fontSize: 12, color: it.userNote ? "#e0af68" : undefined }}
          >
            {it.userNote ? "📋 note ✓" : "✎ add note"}
          </button>
          {it.confidence !== "high" && <span className="muted" style={{ fontSize: 11 }}>({it.confidence})</span>}
          {it.note && <span className="muted" style={{ fontSize: 12 }} title={it.source}>— {it.note}</span>}
          {it.done && it.doneAt && <span className="muted" style={{ fontSize: 11 }}>✓ {new Date(it.doneAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</span>}
          {it.userNote && noteEdit !== it.id && (
            <span className="muted" style={{ fontSize: 12, color: "#e0af68" }} title={it.userNote}>📋 {it.userNote.length > 70 ? `${it.userNote.slice(0, 70)}…` : it.userNote}</span>
          )}
        </div>
        {noteEdit === it.id && (
          <div style={{ margin: "2px 0 6px 26px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="context the AI should know: group members and their roles, links, decisions made…"
              rows={3}
              style={{ width: 420, fontSize: 12, fontFamily: "inherit" }}
              autoFocus
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <button onClick={() => void saveNote(it)}>Save</button>
              <button onClick={() => setNoteEdit(null)} style={{ fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        )}
        {expanded === it.id ? ChecklistBox({ it }) : null}
      </>
    );
  };

  return (
    <>
    <details className="card" style={{ marginTop: 12 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        📅 Deadlines {open.length > 0 && <span className="muted" style={{ fontWeight: 400 }}>— {open.length} open</span>}
        {done.length > 0 && <span className="muted" style={{ fontWeight: 400 }}>· {done.length} done</span>}
        {overdue.length > 0 && <span style={{ color: "#f87171", fontSize: 13, fontWeight: 600 }}>{overdue.length} overdue</span>}
      </summary>
      <div style={{ marginTop: 8 }}>
        {items.length === 0 ? (
          <p className="muted" style={{ margin: "4px 0" }}>Not built yet — the assistant reads every course's documents and extracts due dates + spread-out items.</p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 12, marginBottom: 6, borderBottom: "1px solid #444" }}>
              {(["week", "later", "done"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} style={{ all: "unset", cursor: "pointer", padding: "4px 2px", fontWeight: t === tab ? 600 : 400, color: t === tab ? undefined : "var(--muted, #999)", borderBottom: t === tab ? "2px solid #7aa2f7" : "2px solid transparent" }}>
                  {t === "week" ? `This Week (${weekTab.length})` : t === "later" ? `Later (${laterTab.length})` : `Done (${done.length})`}
                </button>
              ))}
            </div>
            {tab === "week" ? (
              <>
                {overdue.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600, color: "#f87171" }}>Overdue</p>}
                {overdue.map((it) => <Fragment key={it.id}>{Row({ it, hot: true })}</Fragment>)}
                {week.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>Due this week</p>}
                {week.map((it) => <Fragment key={it.id}>{Row({ it })}</Fragment>)}
                {spreadSoon.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>Worth spreading out</p>}
                {spreadSoon.map((it) => <Fragment key={it.id}>{Row({ it })}</Fragment>)}
                {weekTab.length === 0 && <p className="muted" style={{ margin: "4px 0" }}>Nothing due this week — 🎉</p>}
              </>
            ) : tab === "later" ? (
              <>
                {later.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>Due later</p>}
                {later.map((it) => <Fragment key={it.id}>{Row({ it })}</Fragment>)}
                {spreadFar.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>Worth spreading out</p>}
                {spreadFar.map((it) => <Fragment key={it.id}>{Row({ it })}</Fragment>)}
                {laterTab.length === 0 && <p className="muted" style={{ margin: "4px 0" }}>Nothing further out.</p>}
              </>
            ) : (
              <>
                {done.length === 0 && <p className="muted" style={{ margin: "4px 0" }}>Nothing checked off yet.</p>}
                {done.map((it) => <Fragment key={it.id}>{Row({ it })}</Fragment>)}
              </>
            )}
          </>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <button onClick={() => void rebuild("update")} disabled={busy !== ""}>
            {busy === "update" ? "updating… (scans only changed documents — quick)" : items.length ? "Update deadlines" : "Build deadlines"}
          </button>
          <button onClick={() => void rebuild("full")} disabled={busy !== ""} style={{ fontSize: 12 }} title="re-read every document and rebuild from scratch">
            {busy === "full" ? "building… (reads all documents — can take minutes)" : "Full rebuild"}
          </button>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>
    </details>
    {toast && (
      <div
        onClick={() => setToast(null)}
        style={{ position: "fixed", bottom: 18, right: 18, zIndex: 50, maxWidth: 380, cursor: "pointer", background: "#1c2333", border: "1px solid #7aa2f7", borderRadius: 10, padding: "10px 14px", boxShadow: "0 6px 24px rgba(0,0,0,.35)", fontSize: 13 }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>✨ {toast.text}</div>
        {toast.added.slice(0, 6).map((a, i) => (
          <div key={i} style={{ color: "var(--muted, #999)" }}>
            • {a.course.split("-")[1] ?? a.course}: {a.title}{a.due ? ` — due ${a.due}` : " (no date)"}
          </div>
        ))}
        {toast.added.length > 6 && <div style={{ color: "var(--muted, #999)" }}>+{toast.added.length - 6} more…</div>}
        <div style={{ color: "var(--muted, #999)", fontSize: 11, marginTop: 6 }}>click to dismiss</div>
      </div>
    )}
    </>
  );
}
