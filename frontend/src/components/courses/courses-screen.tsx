"use client";
/** Courses & Academic Deadlines screen (stitch screen 1 orchestrator).
 *  Owns the lifted deadline list so the hero actions + KPI stat row stay in
 *  sync with everything the DeadlinesPanel mutates; renders the deadlines
 *  hub, right rail (mappings + daemon listener) and the repositories grid. */
import { useCallback, useState } from "react";
import Link from "next/link";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  BriefcaseIcon,
  CheckCircleIcon,
  CircleStackIcon,
  ClipboardDocumentCheckIcon,
  ClipboardDocumentListIcon,
  CloudIcon,
  ComputerDesktopIcon,
  DocumentIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  FilmIcon,
  FolderIcon,
  FolderOpenIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { GhostButton, Panel, StatCard } from "@/components/ui";
import DeadlinesPanel, { type DeadEntry } from "@/app/deadlines-panel";
import MappingManager from "@/app/mapping-manager";
import CourseNew from "@/app/course-new";
import CourseRename from "@/app/course-rename";
import CourseLink from "@/app/course-link";
import CourseDelete from "@/app/course-delete";
import DaemonCard from "@/components/courses/daemon-card";

export interface CourseSessionRow {
  stem: string;
  date: string;
  time: string | null;
  week: number | null;
  audio: boolean;
  notes: boolean;
  transcript: boolean;
}
export interface CourseCardData {
  slug: string;
  start: string | null;
  sessions: CourseSessionRow[];
}

export interface CoursesScreenProps {
  deadlines: DeadEntry[];
  courseList: CourseCardData[];
  mappingSnap: { mapping: Record<string, string>; folders: string[]; candidates: string[] };
}

function daysUntil(date: string): number {
  return Math.round((Date.parse(`${date}T12:00:00`) - Date.now()) / 86_400_000);
}

const TILE_ICONS = [ComputerDesktopIcon, BriefcaseIcon, Squares2X2Icon, CloudIcon, ShieldCheckIcon, CircleStackIcon];
const TILE_TONES = ["emerald", "cyan", "indigo", "cyan", "red", "emerald"] as const;

export default function CoursesScreen({ deadlines, courseList, mappingSnap }: CoursesScreenProps) {
  const [items, setItems] = useState<DeadEntry[]>(deadlines);
  const [busy, setBusy] = useState<"" | "update" | "full">("");
  const [sig, setSig] = useState<{ mode: "update" | "full"; n: number }>({ mode: "update", n: 0 });

  const [counts, setCounts] = useState(() => {
    const open = deadlines.filter((i) => !i.done);
    return {
      open: open.length,
      done: deadlines.length - open.length,
      overdue: open.filter((i) => i.due && daysUntil(i.due) < 0).length,
    };
  });
  const onCounts = useCallback(
    (c: { open: number; done: number; overdue: number }) => setCounts(c),
    [],
  );
  const onBusyChange = useCallback((b: "" | "update" | "full") => setBusy(b), []);

  const trigger = (mode: "update" | "full") => setSig((s) => ({ mode, n: s.n + 1 }));

  return (
    <div className="courses-screen">
      {/* ── Hero ── */}
      <section className="courses-hero">
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", flexWrap: "wrap" }}>
            <span className="live-dot" />
            <h1 style={{ margin: 0 }}>Courses &amp; Academic Deadlines</h1>
            <span className="courses-hero-badge">
              {items.length > 0 ? "SYNCED" : "NOT BUILT"} // {items.length} ITEMS
            </span>
          </div>
          <p className="panel-sub">
            Automated course folder mappings, transcript extractions, and deadline tracking daemon.
          </p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-sm)" }}>
          <GhostButton icon={<ArrowPathIcon className="heroicon" />} onClick={() => trigger("update")} disabled={busy !== ""}>
            {busy === "update" ? "Updating…" : items.length ? "Update Deadlines" : "Build Deadlines"}
          </GhostButton>
          <GhostButton icon={<ArrowTopRightOnSquareIcon className="heroicon" />} onClick={() => trigger("full")} disabled={busy !== ""} title="re-read every document and rebuild from scratch">
            {busy === "full" ? "Rebuilding…" : "Full Rebuild"}
          </GhostButton>
          <Link href="/courses/ask" className="btn btn-primary" title="One assistant across every course">
            <SparklesIcon className="heroicon" /> Ask AI for All Courses
          </Link>
        </div>
      </section>

      {/* ── KPI stat row ── */}
      <div className="courses-stats">
        <StatCard
          label="Total Active Queue"
          value={<>{counts.open} Open</>}
          tone="emerald"
          icon={<CheckCircleIcon className="heroicon" />}
        />
        <StatCard
          label="Completed Work"
          value={<>{counts.done} Done</>}
          tone="emerald"
          valueClass="stat-card-value--emerald"
          icon={<ClipboardDocumentCheckIcon className="heroicon" />}
        />
        <StatCard
          label="Requires Attention"
          value={<>{counts.overdue} Overdue</>}
          tone="red"
          icon={<ExclamationTriangleIcon className="heroicon" />}
        />
        <StatCard
          label="Registered Folders"
          value={<>{courseList.length} Directories</>}
          tone="indigo"
          valueClass="stat-card-value--indigo"
          icon={<FolderIcon className="heroicon" />}
        />
      </div>

      {/* ── Body: deadlines hub + right rail ── */}
      <div className="courses-body">
        <div style={{ minWidth: 0 }}>
          <DeadlinesPanel
            items={items}
            setItems={setItems}
            rebuildSignal={sig}
            onBusyChange={onBusyChange}
            onCounts={onCounts}
          />
        </div>
        <div className="courses-rail">
          <MappingManager initial={mappingSnap} />
          <DaemonCard />
        </div>
      </div>

      {/* ── Registered course repositories ── */}
      <Panel
        icon={<FolderOpenIcon className="heroicon" />}
        title="Registered Course Repositories"
        actions={<CourseNew />}
      >
        {courseList.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No courses yet — register one above or let the backend record a session.
          </p>
        ) : (
          <div className="repos-grid">
            {courseList.map((c, i) => {
              const Icon = TILE_ICONS[i % TILE_ICONS.length];
              const tone = TILE_TONES[i % TILE_TONES.length];
              const n = c.sessions.length;
              return (
                <details className="repo-card" key={c.slug} open={n > 0 && n <= 3}>
                  <summary>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
                      <div className="repo-card-head" style={{ flex: 1 }}>
                        <span className={`icon-tile icon-tile--${tone}`}>
                          <Icon className="heroicon" />
                        </span>
                        <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                          <CourseLink href={`/course/${encodeURIComponent(c.slug)}`} label={c.slug.replace(/_/g, " ")} />
                          <span className="repo-sessions">
                            {n} indexed session{n === 1 ? "" : "s"}
                          </span>
                        </div>
                      </div>
                      <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", gap: 4 }}>
                        <CourseRename course={c.slug} />
                        {n === 0 && <CourseDelete course={c.slug} />}
                      </span>
                    </div>
                  </summary>
                  {n === 0 ? (
                    <p className="muted" style={{ margin: "8px 0 2px", fontSize: "0.75rem" }}>
                      No sessions yet — ingest a recording from the course page, or wait for the next scheduled one.
                    </p>
                  ) : (
                    <div style={{ margin: "8px 0 2px" }}>
                      {c.sessions.map((s) => (
                        <div key={s.stem} className="repo-session-row">
                          <span className="muted tabular" style={{ fontSize: "0.75rem", minWidth: 90 }}>
                            {s.date}
                            {s.time ? ` ${s.time}` : ""}
                          </span>
                          {s.week !== null && (
                            <span className="muted tabular" style={{ fontSize: "0.6875rem", minWidth: 52 }}>
                              week {s.week}
                            </span>
                          )}
                          <Link
                            href={`/course/${encodeURIComponent(c.slug)}/session/${encodeURIComponent(s.stem)}`}
                            style={{ fontSize: "0.8125rem" }}
                          >
                            {s.stem.split("__").slice(1).join("__").replace(/_/g, " ") || s.stem}
                          </Link>
                          <span className="muted" style={{ fontSize: "0.6875rem", display: "inline-flex", gap: 4, alignItems: "center" }}>
                            {s.audio ? <FilmIcon className="heroicon" title="recording" /> : null}
                            {s.transcript ? <DocumentTextIcon className="heroicon" /> : s.notes ? <DocumentIcon className="heroicon" /> : null}
                            {s.notes ? <ClipboardDocumentListIcon className="heroicon" /> : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
