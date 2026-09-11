"use client";
/** Deadline calendar — AI-built from the real course files. Hard due dates
 *  grouped by urgency; "spread out" items get their own lane. Checked-off
 *  items persist across rebuilds (backend carries done-ness by course+title).
 *  Each row links into that course's chat with a task-specific starter
 *  prompt (guide-me-through for labs/assignments, study plan for exams). */
import { useEffect, useRef, useState } from "react";
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
}

const KIND_ICON: Record<string, string> = {
  assignment: "📝", lab: "🧪", reading: "📖", install: "⬇️",
  signup: "👥", post: "💬", exam: "🎓", other: "📌",
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

export default function DeadlinesPanel({ initial }: { initial: DeadEntry[] }) {
  const router = useRouter();
  const [items, setItems] = useState<DeadEntry[]>(initial);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [tab, setTab] = useState<"up" | "done">("up");

  useEffect(() => setItems(initial), [initial]);

  const rebuild = async (): Promise<void> => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/deadlines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() || undefined }),
      });
      const j = (await r.json().catch(() => ({}))) as { count?: number; error?: string };
      if (!r.ok) setMsg(j.error ?? `HTTP ${r.status}`);
      else {
        setMsg(`built ${j.count} item(s)`);
        const lr = await fetch("/api/deadlines").then((x) => x.json()).catch(() => ({}) as { deadlines?: DeadEntry[] });
        if (lr.deadlines) setItems(lr.deadlines);
        router.refresh();
      }
    } catch { setMsg("rebuild failed — backend unreachable"); }
    finally { setBusy(false); }
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

  const Row = ({ it, hot }: { it: DeadEntry; hot?: boolean }) => (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0", flexWrap: "wrap" }}>
      <input type="checkbox" checked={!!it.done} onChange={() => toggle(it.id)} style={{ accentColor: "#4ade80", transform: "translateY(1px)" }} aria-label={`mark ${it.title} done`} />
      <span style={{ fontSize: 13 }}>{KIND_ICON[it.kind] ?? "📌"}</span>
      <span className="muted" style={{ fontSize: 12, minWidth: 120 }}>{it.due ? fmtDue(it.due) : it.startBy ? `start by ${it.startBy}` : "no date"}</span>
      <span style={{ fontSize: 14, color: hot ? "#f87171" : undefined, fontWeight: hot ? 600 : undefined, textDecoration: it.done ? "line-through" : undefined }}>{it.title}</span>
      <Link href={`/course/${encodeURIComponent(it.course)}?tab=ask&prompt=${encodeURIComponent(starterPrompt(it))}`} style={{ fontSize: 12 }}>ask AI ↗</Link>
      {it.confidence !== "high" && <span className="muted" style={{ fontSize: 11 }}>({it.confidence})</span>}
      {it.note && <span className="muted" style={{ fontSize: 12 }} title={it.source}>— {it.note}</span>}
      {it.done && it.doneAt && <span className="muted" style={{ fontSize: 11 }}>✓ {new Date(it.doneAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</span>}
    </div>
  );

  return (
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
              {(["up", "done"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} style={{ all: "unset", cursor: "pointer", padding: "4px 2px", fontWeight: t === tab ? 600 : 400, color: t === tab ? undefined : "var(--muted, #999)", borderBottom: t === tab ? "2px solid #7aa2f7" : "2px solid transparent" }}>
                  {t === "up" ? "Upcoming" : `Done (${done.length})`}
                </button>
              ))}
            </div>
            {tab === "up" ? (
              <>
                {overdue.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600, color: "#f87171" }}>Overdue</p>}
                {overdue.map((it) => <Row key={it.id} it={it} hot />)}
                {week.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>This week</p>}
                {week.map((it) => <Row key={it.id} it={it} />)}
                {later.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>Later</p>}
                {later.map((it) => <Row key={it.id} it={it} />)}
                {spread.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>Worth spreading out</p>}
                {spread.map((it) => <Row key={it.id} it={it} />)}
                {open.length === 0 && <p className="muted" style={{ margin: "4px 0" }}>Nothing open — 🎉</p>}
              </>
            ) : (
              <>
                {done.length === 0 && <p className="muted" style={{ margin: "4px 0" }}>Nothing checked off yet.</p>}
                {done.map((it) => <Row key={it.id} it={it} />)}
              </>
            )}
          </>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder='optional focus, e.g. "include readings and group signups"'
            style={{ width: 320 }}
          />
          <button onClick={() => void rebuild()} disabled={busy}>{busy ? "building… (reads documents — can take minutes)" : items.length ? "Rebuild with AI" : "Build with AI"}</button>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>
    </details>
  );
}
