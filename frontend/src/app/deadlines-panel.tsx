"use client";
/** Deadline calendar — AI-built from the real course files. Hard due dates
 *  grouped by urgency; "spread out" items (installs, readings, long projects)
 *  get their own lane. Rebuild sweeps every course's documents again, so it
 *  sharpens as materials/sessions accumulate. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export interface DeadEntry {
  course: string;
  title: string;
  due: string | null;
  kind: string;
  spread: boolean;
  startBy: string | null;
  note: string;
  source: string;
  confidence: string;
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

export default function DeadlinesPanel({ initial }: { initial: DeadEntry[] }) {
  const router = useRouter();
  const [items, setItems] = useState<DeadEntry[]>(initial);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(true);

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

  const dated = items.filter((i) => i.due).sort((a, b) => a.due!.localeCompare(b.due!));
  const overdue = dated.filter((i) => daysUntil(i.due!) < 0);
  const week = dated.filter((i) => daysUntil(i.due!) >= 0 && daysUntil(i.due!) <= 7);
  const later = dated.filter((i) => daysUntil(i.due!) > 7);
  const spread = items.filter((i) => !i.due && (i.spread || i.startBy));

  const Row = ({ it, hot }: { it: DeadEntry; hot?: boolean }) => (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0", flexWrap: "wrap" }}>
      <span style={{ fontSize: 13 }}>{KIND_ICON[it.kind] ?? "📌"}</span>
      <span className="muted" style={{ fontSize: 12, minWidth: 120 }}>{it.due ? fmtDue(it.due) : it.startBy ? `start by ${it.startBy}` : "no date"}</span>
      <span style={{ fontSize: 14, color: hot ? "#f87171" : undefined, fontWeight: hot ? 600 : undefined }}>{it.title}</span>
      <span className="muted" style={{ fontSize: 12 }}>· {it.course.replace(/_/g, " ").replace(/^26F-?/, "")}</span>
      {it.confidence !== "high" && <span className="muted" style={{ fontSize: 11 }}>({it.confidence})</span>}
      {it.note && <span className="muted" style={{ fontSize: 12 }} title={it.source}>— {it.note}</span>}
    </div>
  );

  return (
    <details className="card" style={{ marginTop: 12 }} open={open && items.length > 0} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary style={{ cursor: "pointer", fontWeight: 600, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        📅 Deadlines {items.length > 0 && <span className="muted" style={{ fontWeight: 400 }}>— {items.length} item{items.length === 1 ? "" : "s"}</span>}
        {overdue.length > 0 && <span style={{ color: "#f87171", fontSize: 13, fontWeight: 600 }}>{overdue.length} overdue</span>}
      </summary>
      <div style={{ marginTop: 8 }}>
        {items.length === 0 ? (
          <p className="muted" style={{ margin: "4px 0" }}>Not built yet — the assistant reads every course's documents and extracts due dates + spread-out items.</p>
        ) : (
          <>
            {overdue.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600, color: "#f87171" }}>Overdue</p>}
            {overdue.map((it, i) => <Row key={i} it={it} hot />)}
            {week.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>This week</p>}
            {week.map((it, i) => <Row key={i} it={it} />)}
            {later.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>Later</p>}
            {later.map((it, i) => <Row key={i} it={it} />)}
            {spread.length > 0 && <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>Worth spreading out</p>}
            {spread.map((it, i) => <Row key={i} it={it} />)}
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
