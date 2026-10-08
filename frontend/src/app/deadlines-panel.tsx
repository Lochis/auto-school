"use client";
import "./courses-ui.css";
/** Deadline calendar — AI-built from the real course files (stitch screen 1
 *  restyle). Hard due dates grouped by urgency with a date-window section
 *  header; "spread out" items become milestone cards. Checked-off items
 *  persist across rebuilds; each row links into that course's chat with a
 *  task-specific starter prompt. The deadline list is owned by the parent
 *  screen (hero actions + KPI stats share it); this panel mutates it via
 *  the lifted setItems. */
import { Fragment, useEffect, useRef, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AcademicCapIcon, ArrowDownOnSquareIcon, ArrowDownTrayIcon, ArrowPathIcon, ArrowUturnLeftIcon,
  BeakerIcon, BookOpenIcon, BookmarkIcon, CalendarDaysIcon, CalendarIcon, ChatBubbleLeftRightIcon,
  CheckCircleIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, ClipboardDocumentListIcon,
  DocumentTextIcon, ExclamationTriangleIcon, LightBulbIcon, PencilIcon, PencilSquareIcon, PlusIcon,
  QuestionMarkCircleIcon, SparklesIcon, UserGroupIcon, XMarkIcon,
} from "@heroicons/react/24/outline";
import { Badge, Chip, CodeChip, MicroButton, Panel, SearchInput, SegmentedTabs } from "@/components/ui";

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
  dueManual?: boolean;
  stale?: number;
  parts?: { title: string; due: string | null; note: string; done: boolean }[];
}

export interface FoldSuggestion {
  parentId: string;
  parentTitle: string;
  childId: string;
  childTitle: string;
  childDue: string | null;
}

export interface FoldedChild {
  key: string;
  parentId: string;
  parentTitle: string;
  title: string;
  due: string | null;
  done: boolean;
  at: number;
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

export interface DeadlinesPanelProps {
  /** lifted deadline list — owned by the courses screen (KPIs + hero) */
  items: DeadEntry[];
  setItems: React.Dispatch<React.SetStateAction<DeadEntry[]>>;
  /** bump {mode, n} to trigger a rebuild from the hero buttons */
  rebuildSignal?: { mode: "update" | "full"; n: number };
  onBusyChange?: (busy: "" | "update" | "full") => void;
  onCounts?: (counts: { open: number; done: number; overdue: number }) => void;
}

const KIND_ICON: Record<string, ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  assignment: DocumentTextIcon, lab: BeakerIcon, reading: BookOpenIcon, install: ArrowDownTrayIcon,
  signup: UserGroupIcon, post: ChatBubbleLeftRightIcon, quiz: QuestionMarkCircleIcon, exam: AcademicCapIcon, other: BookmarkIcon,
};

function daysUntil(date: string): number {
  return Math.round((Date.parse(`${date}T12:00:00`) - Date.now()) / 86_400_000);
}
function fmtDue(date: string): string {
  const d = daysUntil(date);
  const when = d === 0 ? "today" : d === 1 ? "tomorrow" : d < 0 ? `${-d}d overdue` : d <= 7 ? `in ${d}d` : new Date(`${date}T12:00:00`).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  return `${date} (${when})`;
}
/** compact chip label in the stitch style: "Due Tomorrow", "Oct 09 (in 2d)" */
function dueChipLabel(date: string): string {
  const d = daysUntil(date);
  if (d === 0) return "Due Today";
  if (d === 1) return "Due Tomorrow";
  if (d > 1 && d <= 7) return `${new Date(`${date}T12:00:00`).toLocaleDateString("en-CA", { month: "short", day: "2-digit" })} (in ${d}d)`;
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}
function fmtWindow(d: Date): string {
  return d.toLocaleDateString("en-CA", { month: "short", day: "2-digit" }).toUpperCase();
}

function KindIcon({ it }: { it: DeadEntry }): React.ReactNode {
  const K = KIND_ICON[it.kind] ?? BookmarkIcon;
  return <K className="heroicon" style={{ display: "inline", marginTop: 3, color: "var(--outline)" }} />;
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

/** parse "Weight: 25%"-style text out of an item note */
function weightOf(it: DeadEntry): number | null {
  const m = it.note.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

export default function DeadlinesPanel({ items, setItems, rebuildSignal, onBusyChange, onCounts }: DeadlinesPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"" | "update" | "full">("");
  const [msg, setMsg] = useState("");
  const [toast, setToast] = useState<{ added: { course: string; title: string; due: string | null }[]; updated: { course: string; title: string; due: string | null; was: string | null }[]; text: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 10_000);
    return () => clearTimeout(t);
  }, [toast]);
  const [tab, setTab] = useState<"week" | "later" | "done">("week");
  const [q, setQ] = useState(""); // text filter over rows
  const [sel, setSel] = useState<Set<string>>(new Set()); // row selection
  const [showMs, setShowMs] = useState(true); // milestones section
  // ── fold suggestions (sub-task → parent checklist), accepted/declined once ──
  const [sugs, setSugs] = useState<FoldSuggestion[]>([]);
  const [foldedCh, setFoldedCh] = useState<FoldedChild[]>([]);
  const [foldPick, setFoldPick] = useState<string | null>(null); // row whose fold-picker is open
  const [foldQ, setFoldQ] = useState("");
  const [showFolds, setShowFolds] = useState<string | null>(null); // row with its folded list expanded
  useEffect(() => {
    fetch("/api/deadlines")
      .then((r) => r.json())
      .then((j: { deadlines?: DeadEntry[]; suggestions?: FoldSuggestion[]; foldedChildren?: FoldedChild[] }) => {
        if (j.deadlines) setItems(j.deadlines);
        if (j.suggestions) setSugs(j.suggestions);
        if (j.foldedChildren) setFoldedCh(j.foldedChildren);
      })
      .catch(() => { /* props initial is fine */ });
  }, [setItems]);
  // ── per-deadline checklists ──
  const [cks, setCks] = useState<Record<string, Checklist>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState<Record<string, boolean>>({});
  const [ckMsg, setCkMsg] = useState<Record<string, string>>({});
  const [addText, setAddText] = useState<Record<string, string>>({});
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const [noteText, setNoteText] = useState<string>("");
  const [dateEdit, setDateEdit] = useState<string | null>(null);
  const [dateVal, setDateVal] = useState<string>("");
  const [startByVal, setStartByVal] = useState<string>("");

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
    onBusyChange?.(mode);
    try {
      const r = await fetch("/api/deadlines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const j = (await r.json().catch(() => ({}))) as { count?: number; error?: string; added?: { course: string; title: string; due: string | null }[]; updated?: { course: string; title: string; due: string | null; was: string | null }[]; deduped?: number; changed?: number; mode?: string };
      if (!r.ok) setMsg(j.error ?? `HTTP ${r.status}`);
      else {
        const upd = j.updated ?? [];
        if (j.mode === "update") {
          setMsg(`updated — ${j.count} item(s), ${j.changed ?? 0} doc(s) scanned${upd.length ? `, ${upd.length} date(s) changed` : ""}${j.deduped ? `, ${j.deduped} duplicate(s) merged` : ""}`);
          if (j.added?.length || upd.length) setToast({ added: j.added ?? [], updated: upd, text: `${j.added?.length ?? 0} new deadline${(j.added?.length ?? 0) === 1 ? "" : "s"}, ${upd.length} date${upd.length === 1 ? "" : "s"} updated:` });
        } else setMsg(`built ${j.count} item(s)${upd.length ? `, ${upd.length} date(s) changed` : ""}${j.deduped ? `, ${j.deduped} duplicate(s) merged` : ""}`);
        const lr = await fetch("/api/deadlines").then((x) => x.json()).catch(() => ({}) as { deadlines?: DeadEntry[]; suggestions?: FoldSuggestion[]; foldedChildren?: FoldedChild[] });
        if (lr.deadlines) setItems(lr.deadlines);
        if (lr.suggestions) setSugs(lr.suggestions);
        if (lr.foldedChildren) setFoldedCh(lr.foldedChildren);
        router.refresh();
      }
    } catch { setMsg("rebuild failed — backend unreachable"); }
    finally { setBusy(""); onBusyChange?.(""); }
  };

  // hero-triggered rebuilds arrive as a bumped signal (initial value must not fire)
  const sigSeen = useRef<{ mode: string; n: number } | undefined>(rebuildSignal);
  useEffect(() => {
    if (!rebuildSignal || sigSeen.current === rebuildSignal) return;
    sigSeen.current = rebuildSignal;
    void rebuild(rebuildSignal.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildSignal]);

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

  const saveDates = async (it: DeadEntry): Promise<void> => {
    setDateEdit(null);
    const body: Record<string, unknown> = { id: it.id, due: dateVal.trim() || null };
    if (startByVal.trim()) body.startBy = startByVal.trim();
    // optimistic
    setItems((m) => m.map((x) => (x.id === it.id ? { ...x, due: (body.due as string | null), startBy: startByVal.trim() || null, dueManual: true, confidence: "high" } : x)));
    try {
      const r = await fetch("/api/deadlines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { deadlines?: DeadEntry[] };
      if (j.deadlines) setItems(j.deadlines); // server truth
    } catch { /* keep optimistic state */ }
  };

  const revertDate = async (it: DeadEntry): Promise<void> => {
    setDateEdit(null);
    setItems((m) => m.map((x) => (x.id === it.id ? { ...x, dueManual: undefined, confidence: "medium" } : x)));
    try {
      const r = await fetch("/api/deadlines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it.id, revert: true }) });
      const j = (await r.json().catch(() => ({}))) as { deadlines?: DeadEntry[] };
      if (j.deadlines) setItems(j.deadlines);
    } catch { /* keep optimistic state */ }
  };

  const removeStale = async (it: DeadEntry): Promise<void> => {
    setItems((m) => m.filter((x) => x.id !== it.id)); // optimistic
    try {
      const r = await fetch("/api/deadlines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it.id, delete: true }) });
      const j = (await r.json().catch(() => ({}))) as { deadlines?: DeadEntry[] };
      if (j.deadlines) setItems(j.deadlines); // server truth
      router.refresh();
    } catch { /* keep optimistic state */ }
  };

  const acceptFold = async (s: FoldSuggestion): Promise<void> => {
    setSugs((m) => m.filter((x) => x.childId !== s.childId)); // optimistic
    try {
      const r = await fetch("/api/deadlines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acceptFold: { parent: s.parentId, child: s.childId } }) });
      const j = (await r.json().catch(() => ({}))) as { deadlines?: DeadEntry[] };
      if (j.deadlines) setItems(j.deadlines); // server truth (child is gone, checklist grew)
      await refreshCks();
      router.refresh();
    } catch { /* gone */ }
  };

  const declineFold = async (s: FoldSuggestion): Promise<void> => {
    setSugs((m) => m.filter((x) => x.childId !== s.childId)); // optimistic — never asked again
    try { await fetch("/api/deadlines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ declineFold: { child: s.childId } }) }); }
    catch { /* gone */ }
  };

  const foldTargets = (it: DeadEntry): DeadEntry[] =>
    items.filter((x) => x.course === it.course && !x.done && x.id !== it.id)
      .filter((x) => !foldQ.trim() || x.title.toLowerCase().includes(foldQ.trim().toLowerCase()));

  const doFold = async (it: DeadEntry, parentId: string): Promise<void> => {
    setFoldPick(null);
    setItems((m) => m.filter((x) => x.id !== it.id)); // optimistic — child folds away now
    try {
      const r = await fetch("/api/deadlines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fold: { parent: parentId, child: it.id } }) });
      const j = (await r.json().catch(() => ({}))) as { deadlines?: DeadEntry[] };
      if (j.deadlines) setItems(j.deadlines); // server truth
      await refreshCks();
      router.refresh();
    } catch { /* keep optimistic state */ }
  };

  const unfold = async (key: string): Promise<void> => {
    try {
      const r = await fetch("/api/deadlines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unfold: { key } }) });
      const j = (await r.json().catch(() => ({}))) as { deadlines?: DeadEntry[] };
      if (j.deadlines) setItems(j.deadlines);
      setFoldedCh((m) => m.filter((x) => x.key !== key));
      await refreshCks();
      router.refresh();
    } catch { /* leave */ }
  };

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

  // report counts up to the screen (hero KPI row)
  useEffect(() => {
    onCounts?.({ open: open.length, done: done.length, overdue: overdue.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.length, done.length, overdue.length]);

  // text filter over title / course / note
  const matches = (it: DeadEntry): boolean => {
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return (
      it.title.toLowerCase().includes(t) ||
      it.course.toLowerCase().includes(t) ||
      courseCode(it.course).toLowerCase().includes(t) ||
      it.note.toLowerCase().includes(t) ||
      (it.userNote ?? "").toLowerCase().includes(t)
    );
  };
  const f = (arr: DeadEntry[]): DeadEntry[] => (q.trim() ? arr.filter(matches) : arr);

  const toggleSel = (id: string): void => {
    setSel((m) => {
      const n = new Set(m);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const selBar = sel.size > 0 && (
    <div className="cdl-sub" style={{ margin: "0 0 6px", borderColor: "var(--secondary)" }}>
      <strong style={{ color: "var(--secondary)" }}>{sel.size} selected</strong>
      <MicroButton
        icon={<CheckCircleIcon className="heroicon" />}
        onClick={() => { sel.forEach((id) => toggle(id)); setSel(new Set()); }}
        title={tab === "done" ? "restore as open work" : "check these off"}
      >
        {tab === "done" ? "Restore selected" : "Mark done"}
      </MicroButton>
      <MicroButton onClick={() => setSel(new Set())}>Clear</MicroButton>
    </div>
  );

  const ChecklistBox = ({ it }: { it: DeadEntry }) => {
    const c = cks[it.id];
    if (!c) {
      return (
        <div className="cdl-ck" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => void genCk(it)} disabled={!!genBusy[it.id]}>
            {genBusy[it.id] ? "building… (reads the task sheet — can take a minute)" : "Generate checklist with AI"}
          </button>
          {ckMsg[it.id] && <span className="muted" style={{ fontSize: 12, color: "var(--error)" }}>{ckMsg[it.id]}</span>}
        </div>
      );
    }
    const doneN = c.items.filter((x) => x.done).length;
    const pct = c.items.length ? Math.round((doneN / c.items.length) * 100) : 0;
    return (
      <div className="cdl-ck">
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: doneN === c.items.length && c.items.length > 0 ? "var(--primary)" : undefined }}>
            {doneN}/{c.items.length} steps{doneN === c.items.length && c.items.length > 0 ? <> — done <CheckIcon className="heroicon" style={{ display: "inline" }} /></> : ""}
          </span>
          <div style={{ width: 90, height: 5, borderRadius: 3, background: "var(--surface-container-high)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: doneN === c.items.length ? "var(--primary-container)" : "var(--secondary)" }} />
          </div>
          <button
            onClick={() => void genCk(it)} disabled={!!genBusy[it.id]} title="re-sweep the materials; checked steps stay checked"
            style={{ fontSize: 11, padding: "1px 7px" }}
          >
            {genBusy[it.id] ? "rebuilding…" : <><ArrowPathIcon className="heroicon" /> Regenerate</>}
          </button>
          <button
            onClick={() => { void fetch(`/api/checklists?deadlineId=${encodeURIComponent(it.id)}`, { method: "DELETE" }).then(() => refreshCks()); }}
            title="delete this checklist (the deadline itself stays)"
            style={{ fontSize: 11, padding: "1px 7px" }}
          >
            <XMarkIcon className="heroicon" /> remove
          </button>
          {ckMsg[it.id] && <span className="muted" style={{ fontSize: 12, color: "var(--error)" }}>{ckMsg[it.id]}</span>}
        </div>
        {genBusy[it.id] && <p className="muted" style={{ margin: "2px 0 4px", fontSize: 12 }}>building… (reads the task sheet — can take a minute)</p>}
        {c.items.map((x) => (
          <div key={x.id} style={{ display: "flex", gap: 7, alignItems: "baseline", padding: "2px 0" }}>
            <input type="checkbox" checked={x.done} aria-label={x.text}
              onChange={() => {
                setCks((m) => ({ ...m, [it.id]: { ...c, items: c.items.map((y) => (y.id === x.id ? { ...y, done: !y.done, doneAt: !y.done ? Date.now() : null } : y)) } })); // optimistic
                void postCk({ deadlineId: it.id, itemId: x.id, done: !x.done });
              }}
              style={{ accentColor: "var(--secondary)", transform: "translateY(1px)" }}
            />
            <span style={{ fontSize: 13, textDecoration: x.done ? "line-through" : undefined, opacity: x.done ? 0.6 : 1 }}>{x.text}{x.manual ? <PencilIcon className="heroicon" style={{ display: "inline" }} /> : ""}</span>
            <button onClick={() => void postCk({ deadlineId: it.id, removeItemId: x.id })} title="remove step" style={{ all: "unset", cursor: "pointer", fontSize: 11, color: "var(--text-low)" }}><XMarkIcon className="heroicon" /></button>
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

  const Row = ({ it, hot }: { it: DeadEntry; hot?: boolean }): React.ReactNode => {
    const ck = cks[it.id];
    const doneN = ck ? ck.items.filter((x) => x.done).length : 0;
    const myFolds = foldedCh.filter((fd) => fd.parentId === it.id);
    const od = it.due ? daysUntil(it.due) : null;
    const isOverdue = !!it.due && od !== null && od < 0 && !it.done;
    return (
      <>
        <div className={`cdl-row ${isOverdue ? "cdl-row--overdue" : ""} ${it.done ? "cdl-row--done" : ""}`}>
          <div className="cdl-top">
            <input
              type="checkbox"
              className={`cdl-check ${isOverdue ? "cdl-check--danger" : ""}`}
              checked={sel.has(it.id)}
              onChange={() => toggleSel(it.id)}
              aria-label={`select ${it.title}`}
            />
            <KindIcon it={it} />                <span className="cdl-title" title={it.title}>{it.title}</span>
                <Link className="cdl-chiplink" href={`/course/${encodeURIComponent(it.course)}`} title="open course — ${it.course}" onClick={(e) => e.stopPropagation()}>
                  <CodeChip title={it.course}>{courseCode(it.course)}</CodeChip>
                </Link>
                {isOverdue && it.due ? (
                  <Badge variant="red" title={`due ${it.due}`}>OVERDUE ({-od!}D)</Badge>
                ) : it.due ? (
                  <Chip tone={od === 0 || od === 1 ? "cyan" : "neutral"} title={fmtDue(it.due)}>{dueChipLabel(it.due)}</Chip>
                ) : it.startBy ? (
                  <Chip tone="cyan" title="spread out — start by this date">Start: {it.startBy}</Chip>
                ) : (
                  <Chip tone="neutral">no date</Chip>
                )}
                {it.dueManual && <PencilIcon className="heroicon cdl-iconbtn--amber" title="date set manually — survives rebuilds" style={{ display: "inline" }} />}
              
          </div>
          <div className="cdl-bottom">
            <div className="cdl-meta">
                {ck && <span>Progress: <strong>{doneN}/{ck.items.length} tasks</strong></span>}
                {ck && <span>•</span>}
                {it.stale && (
                  <span style={{ color: "#e0af68" }} title={`not seen in its source at the last update (${new Date(it.stale).toLocaleDateString("en-CA")}) — verify or remove`}>
                    <ExclamationTriangleIcon className="heroicon" style={{ display: "inline" }} /> not in source
                  </span>
                )}
                {it.stale && (
                  <button onClick={() => void removeStale(it)} className="cdl-iconbtn cdl-iconbtn--red" title="remove this entry (its source no longer defines it)"><XMarkIcon className="heroicon" /></button>
                )}
                {it.confidence !== "high" && <span>({it.confidence})</span>}
                {it.note && <span title={it.source}>— {it.note}</span>}
                {it.userNote && noteEdit !== it.id && (
                  <span style={{ color: "#e0af68" }} title={it.userNote}><ClipboardDocumentListIcon className="heroicon" style={{ display: "inline" }} /> {it.userNote.length > 70 ? `${it.userNote.slice(0, 70)}…` : it.userNote}</span>
                )}
                {it.done && it.doneAt && <span><CheckIcon className="heroicon" style={{ display: "inline" }} /> {new Date(it.doneAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</span>}
              </div>
                      <div className="cdl-actions">
            <Link
              href={`/course/${encodeURIComponent(it.course)}?tab=ask&prompt=${encodeURIComponent(starterPrompt(it))}`}
              className="btn btn-micro" style={{ color: "var(--primary)" }}
              title="ask the course assistant about this task"
            >
              <SparklesIcon className="heroicon" /> Ask AI
            </Link>
            <MicroButton
              onClick={() => { if (ck) setExpanded(expanded === it.id ? null : it.id); else { setExpanded(it.id); void genCk(it); } }}
              disabled={!!genBusy[it.id]}
              title={ck ? "show checklist" : "AI-generate an execution checklist for this task"}
            >
              {genBusy[it.id] ? "building…" : ck ? <><CheckIcon className="heroicon" /> {doneN}/{ck.items.length}{expanded === it.id ? <ChevronUpIcon className="heroicon" /> : <ChevronDownIcon className="heroicon" />}</> : <><PlusIcon className="heroicon" /> Checklist</>}
            </MicroButton>
            <button
              onClick={() => { setNoteEdit(noteEdit === it.id ? null : it.id); setNoteText(it.userNote ?? ""); }}
              className="cdl-iconbtn"
              title="add your own context — group members, roles, links… (shown to the AI and kept across rebuilds)"
            >
              {it.userNote ? <ClipboardDocumentListIcon className="heroicon" /> : <PencilSquareIcon className="heroicon" />}
            </button>
            <button
              onClick={() => toggle(it.id)}
              className="cdl-iconbtn"
              title={it.done ? "restore as open work" : "mark done"}
              style={{ color: it.done ? "var(--primary)" : undefined }}
            >
              <CheckCircleIcon className="heroicon" />
            </button>
            <button
              onClick={() => { setDateEdit(dateEdit === it.id ? null : it.id); setDateVal(it.due ?? ""); setStartByVal(it.startBy ?? ""); }}
              className="cdl-iconbtn"
              title="change the due date (kept across rebuilds)"
            >
              <CalendarIcon className="heroicon" />
            </button>
            {!it.done && (
              <button onClick={() => { setFoldPick(foldPick === it.id ? null : it.id); setFoldQ(""); }} className="cdl-iconbtn cdl-iconbtn--amber" title="fold this into another deadline's checklist — it becomes a step there (unfoldable later)">
                <ArrowDownOnSquareIcon className="heroicon" />
              </button>
            )}
            {myFolds.length > 0 && (
              <button onClick={() => setShowFolds(showFolds === it.id ? null : it.id)} className="cdl-iconbtn cdl-iconbtn--amber" title="folded sub-tasks — unfold to restore them as their own deadlines">
                <ArrowDownOnSquareIcon className="heroicon" /> {myFolds.length}
              </button>
            )}
            </div>
          </div>
        </div>
        {dateEdit === it.id && (
          <div className="cdl-sub">
            <label>due <input type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)} style={{ fontSize: 12 }} /></label>
            <label className="muted">start by <input type="date" value={startByVal} onChange={(e) => setStartByVal(e.target.value)} style={{ fontSize: 12 }} /></label>
            <button onClick={() => void saveDates(it)}>Save</button>
            <button onClick={() => setDateEdit(null)} style={{ fontSize: 12 }}>Cancel</button>
            {it.dueManual && <button onClick={() => void revertDate(it)} title="drop the manual override; next rebuild re-extracts from course docs" style={{ fontSize: 12 }}>revert to auto</button>}
          </div>
        )}
        {foldPick === it.id && (
          <div className="cdl-sub" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <input autoFocus value={foldQ} onChange={(e) => setFoldQ(e.target.value)} placeholder="fold into which deadline? (same course)" style={{ width: "min(360px, 80vw)", fontSize: 12 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {foldTargets(it).slice(0, 8).map((x) => (
                <button key={x.id} onClick={() => void doFold(it, x.id)} style={{ all: "unset", cursor: "pointer", color: "var(--secondary)", textAlign: "left" }}><ArrowDownOnSquareIcon className="heroicon" style={{ display: "inline" }} /> {x.title}{x.due ? ` (${x.due})` : ""}</button>
              ))}
              {foldTargets(it).length === 0 && <span className="muted">no other open deadline in this course</span>}
            </div>
            <button onClick={() => setFoldPick(null)} style={{ fontSize: 11, marginTop: 4, alignSelf: "flex-start" }}>Cancel</button>
          </div>
        )}
        {showFolds === it.id && myFolds.map((fc) => (
          <div key={fc.key} className="cdl-sub" style={{ fontSize: 12 }}>
            <span className="muted"><ArrowDownOnSquareIcon className="heroicon" style={{ display: "inline" }} /> {fc.title}{fc.due ? ` (${fc.due})` : ""}{fc.done ? " — was done" : ""}</span>
            <button onClick={() => void unfold(fc.key)} className="iconbtn" title="restore as its own deadline (removes exactly the steps the fold added)" style={{ fontSize: 11 }}><ArrowUturnLeftIcon className="heroicon" style={{ display: "inline" }} /> unfold</button>
          </div>
        ))}
        {noteEdit === it.id && (
          <div className="cdl-sub" style={{ alignItems: "flex-start" }}>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="context the AI should know: group members and their roles, links, decisions made…"
              rows={3}
              style={{ width: "min(420px, 100%)", fontSize: 12, fontFamily: "inherit" }}
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

  /** milestone card for spread-out items ("Worth Spreading Out") */
  const Milestone = ({ it }: { it: DeadEntry }): React.ReactNode => {
    const w = weightOf(it);
    const ck = cks[it.id];
    const doneN = ck ? ck.items.filter((x) => x.done).length : 0;
    return (
      <div className="cdl-milestone">
        <div className="cdl-milestone-head">
          <Link className="cdl-chiplink" href={`/course/${encodeURIComponent(it.course)}`} title="open course — ${it.course}" onClick={(e) => e.stopPropagation()}>
            <CodeChip title={it.course}>{courseCode(it.course)}</CodeChip>
          </Link>
          <span className="tabular" style={{ fontSize: "0.6875rem", color: "var(--secondary)" }}>
            Start: {it.startBy ?? "anytime"}
          </span>
          <input
            type="checkbox"
            className="cdl-check"
            style={{ marginTop: 0 }}
            checked={sel.has(it.id)}
            onChange={() => toggleSel(it.id)}
            aria-label={`select ${it.title}`}
          />
        </div>
        <div className="cdl-title" style={{ marginTop: 2 }}>{it.title}</div>
        {it.note && <div className="cdl-meta">{it.note}</div>}
        {it.userNote && <div className="cdl-meta" style={{ color: "#e0af68" }} title={it.userNote}><ClipboardDocumentListIcon className="heroicon" style={{ display: "inline" }} /> {it.userNote.length > 80 ? `${it.userNote.slice(0, 80)}…` : it.userNote}</div>}
        <div className="cdl-milestone-foot">
          {w !== null && <Chip>Weight: {w}%</Chip>}
          {w !== null && w >= 15 ? <Badge variant="indigo">High Impact</Badge> : null}
          {w === null && <Chip>Milestone</Chip>}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            <Link
              href={`/course/${encodeURIComponent(it.course)}?tab=ask&prompt=${encodeURIComponent(starterPrompt(it))}`}
              className="btn btn-micro" style={{ color: "var(--primary)" }}
              title="ask the course assistant for a plan"
            >
              <SparklesIcon className="heroicon" /> Study Plan
            </Link>
            <MicroButton
              onClick={() => { if (ck) setExpanded(expanded === it.id ? null : it.id); else { setExpanded(it.id); void genCk(it); } }}
              disabled={!!genBusy[it.id]}
              title={ck ? "show checklist" : "AI-generate an execution checklist"}
            >
              {genBusy[it.id] ? "building…" : ck ? <><CheckIcon className="heroicon" /> {doneN}/{ck.items.length}</> : <><PlusIcon className="heroicon" /> Checklist</>}
            </MicroButton>
            <button
              onClick={() => { setNoteEdit(noteEdit === it.id ? null : it.id); setNoteText(it.userNote ?? ""); }}
              className="cdl-iconbtn" title="edit note"
            >
              <PencilSquareIcon className="heroicon" />
            </button>
            <button
              onClick={() => { setDateEdit(dateEdit === it.id ? null : it.id); setDateVal(it.due ?? ""); setStartByVal(it.startBy ?? ""); }}
              className="cdl-iconbtn" title="set due / start-by dates"
            >
              <CalendarIcon className="heroicon" />
            </button>
          </div>
        </div>
        {dateEdit === it.id && (
          <div className="cdl-sub" style={{ margin: "2px 0 0" }}>
            <label>due <input type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)} style={{ fontSize: 12 }} /></label>
            <label className="muted">start by <input type="date" value={startByVal} onChange={(e) => setStartByVal(e.target.value)} style={{ fontSize: 12 }} /></label>
            <button onClick={() => void saveDates(it)}>Save</button>
            <button onClick={() => setDateEdit(null)} style={{ fontSize: 12 }}>Cancel</button>
            {it.dueManual && <button onClick={() => void revertDate(it)} style={{ fontSize: 12 }}>revert to auto</button>}
          </div>
        )}
        {noteEdit === it.id && (
          <div className="cdl-sub" style={{ margin: "2px 0 0", alignItems: "flex-start" }}>
            <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={3} placeholder="context the AI should know…" style={{ width: "min(420px, 100%)", fontSize: 12, fontFamily: "inherit" }} autoFocus />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <button onClick={() => void saveNote(it)}>Save</button>
              <button onClick={() => setNoteEdit(null)} style={{ fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        )}
        {expanded === it.id ? ChecklistBox({ it }) : null}
      </div>
    );
  };

  const winText = `${fmtWindow(new Date())} — ${fmtWindow(new Date(Date.now() + 6 * 86_400_000))}`;
  // milestone cards: every open spread-out item, even when it also carries a
  // hard due date (those still show as dated rows in the tabs above)
  const milestones = f(open.filter((i) => i.spread || i.startBy));

  return (
    <>
      <Panel
        icon={<CalendarDaysIcon className="heroicon" />}
        title="Scheduled Course Deadlines"
        actions={
          <SearchInput
            placeholder="Filter assignments, tests…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 220 }}
          />
        }
      >
        <SegmentedTabs
          className="cdl-tabs"
          items={[
            { label: "This Week", count: weekTab.length, active: tab === "week", onClick: () => setTab("week") },
            { label: "Later", count: laterTab.length, active: tab === "later", onClick: () => setTab("later") },
            { label: "Done", count: done.length, active: tab === "done", onClick: () => setTab("done") },
          ]}
        />
        <div style={{ height: 12 }} />

        {sugs.length > 0 && (
          <div className="callout" style={{ marginBottom: 10, borderColor: "#8a6d3b" }}>
            {sugs.map((s) => (
              <div key={s.childId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "2px 0" }}>
                <span style={{ fontSize: 13 }}>
                  <LightBulbIcon className="heroicon" style={{ display: "inline" }} /> <strong>{s.childTitle}</strong>{s.childDue ? ` (${s.childDue})` : ""} looks like part of <strong>{s.parentTitle}</strong> — fold it into that checklist?
                </span>
                <button onClick={() => void acceptFold(s)}>Fold</button>
                <button onClick={() => void declineFold(s)} style={{ fontSize: 12 }}>Keep separate</button>
              </div>
            ))}
          </div>
        )}

        {selBar}

        {items.length === 0 ? (
          <p className="muted" style={{ margin: "4px 0" }}>Not built yet — the assistant reads every course&apos;s documents and extracts due dates + spread-out items.</p>
        ) : tab === "week" ? (
          <>
            {f(overdue).length > 0 && (
              <>
                <div className="cdl-section-head">
                  <span className="eyebrow" style={{ color: "var(--error)" }}>Overdue</span>
                  <span className="cdl-window">{f(overdue).length} ITEM{f(overdue).length === 1 ? "" : "S"}</span>
                </div>
                <div className="cdl-rows" style={{ marginBottom: 10 }}>
                  {f(overdue).map((it) => <Fragment key={it.id}>{Row({ it, hot: true })}</Fragment>)}
                </div>
              </>
            )}
            {f(week).length > 0 && (
              <>
                <div className="cdl-section-head">
                  <span className="eyebrow">Immediate Deliverables</span>
                  <span className="cdl-window">{winText}</span>
                </div>
                <div className="cdl-rows" style={{ marginBottom: 10 }}>
                  {f(week).map((it) => <Fragment key={it.id}>{Row({ it })}</Fragment>)}
                </div>
              </>
            )}
            {f(spreadSoon).length === 0 && f(week).length === 0 && f(overdue).length === 0 && (
              <p className="muted" style={{ margin: "4px 0" }}>Nothing due this week — <SparklesIcon className="heroicon" style={{ display: "inline" }} /></p>
            )}
          </>
        ) : tab === "later" ? (
          <>
            {f(later).length > 0 && (
              <>
                <div className="cdl-section-head">
                  <span className="eyebrow">Due Later</span>
                  <span className="cdl-window">{f(later).length} ITEM{f(later).length === 1 ? "" : "S"}</span>
                </div>
                <div className="cdl-rows" style={{ marginBottom: 10 }}>
                  {f(later).map((it) => <Fragment key={it.id}>{Row({ it })}</Fragment>)}
                </div>
              </>
            )}
            {f(spreadFar).length === 0 && f(later).length === 0 && <p className="muted" style={{ margin: "4px 0" }}>Nothing further out.</p>}
          </>
        ) : (
          <>
            {done.length === 0 && <p className="muted" style={{ margin: "4px 0" }}>Nothing checked off yet.</p>}
            <div className="cdl-rows">
              {f(done).map((it) => <Fragment key={it.id}>{Row({ it })}</Fragment>)}
            </div>
          </>
        )}

        {milestones.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Panel
              eyebrow="Worth Spreading Out"
              icon={<CalendarDaysIcon className="heroicon" />}
              title="Upcoming Milestones"
              actions={
                <>
                  <Chip pill>{milestones.length} items</Chip>
                  <MicroButton onClick={() => setShowMs(!showMs)} title={showMs ? "collapse" : "expand"}>
                    {showMs ? "Collapse" : "Expand"}
                    {showMs ? <ChevronUpIcon className="heroicon" /> : <ChevronDownIcon className="heroicon" />}
                  </MicroButton>
                </>
              }
            >
              {showMs && (
                <div className="cdl-milestones">
                  {milestones.map((it) => <Fragment key={it.id}>{Milestone({ it })}</Fragment>)}
                </div>
              )}
            </Panel>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </Panel>
      {toast && (
        <div className="cdl-toast" onClick={() => setToast(null)}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}><SparklesIcon className="heroicon" style={{ display: "inline" }} /> {toast.text}</div>
          {toast.updated.slice(0, 6).map((u, i) => (
            <div key={`u${i}`} className="cdl-toast-line">
              • {u.course.split("-")[1] ?? u.course}: {u.title}{u.due ? ` — due ${u.due}` : " (no date)"}{u.was ? ` (was ${u.was})` : ""}
            </div>
          ))}
          {toast.added.slice(0, 6).map((a, i) => (
            <div key={`a${i}`} className="cdl-toast-line">
              • {a.course.split("-")[1] ?? a.course}: {a.title}{a.due ? ` — due ${a.due}` : " (no date)"}
            </div>
          ))}
          {toast.added.length + toast.updated.length > 6 && <div className="cdl-toast-line">+{toast.added.length + toast.updated.length - 6} more…</div>}
          <div className="cdl-toast-line" style={{ fontSize: 11, marginTop: 6 }}>click to dismiss</div>
        </div>
      )}
    </>
  );
}
