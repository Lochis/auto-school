"use client";
/** Completed Sessions panel (stitch screen 5): pipeline sessions that
 *  reached done/failed, straight from the daemon's session board
 *  (/api/backend → sessions[]). Folder action deep-links into the course
 *  session page when the recording was filed. */
import Link from "next/link";
import { useStatus, type Status } from "@/lib/use-status";
import { Badge, Panel } from "@/components/ui";
import {
  CheckBadgeIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
} from "@heroicons/react/24/outline";

interface SessionRow {
  stem: string;
  title: string;
  course?: string;
  stage: string;
  stageNote?: string;
  segCount?: number;
  mp4?: string;
  sizeMB?: number;
  updatedAt: number;
}

const MAX_ROWS = 8;

/** "SEC. 402" / "SEC 401" chip value from a meeting title, if present */
function secOf(title: string): string | null {
  return title.match(/\bSEC?[.\s]*(\d{3})\b/i)?.[1] ?? null;
}

function humanMB(mb?: number): string | null {
  if (!mb || mb <= 0) return null;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

/** the mp4 field is `recordings/<course>/<file>.mp4` — link the row's folder
 *  button into the session detail page for that recording */
function sessionHref(s: SessionRow): string | null {
  const course = s.course ?? s.mp4?.match(/^recordings\/([^/]+)\//)?.[1];
  const file = s.mp4?.split("/").pop()?.replace(/\.(mp4|webm)$/, "");
  if (!course || !file) return null;
  return `/course/${encodeURIComponent(course)}/session/${encodeURIComponent(file)}`;
}

export default function CompletedSessions() {
  const status = useStatus();
  const all = (status?.sessions ?? []) as SessionRow[];
  const done = all.filter((s) => s.stage === "done" || s.stage === "failed");
  const rows = done.slice(0, MAX_ROWS);
  const totalMB = done.reduce((a, s) => a + (s.sizeMB ?? 0), 0);
  const total = humanMB(totalMB);

  return (
    <Panel
      icon={<CheckBadgeIcon className="heroicon" />}
      title="Completed Sessions"
      subtitle={`${done.length} capture${done.length === 1 ? "" : "s"} consolidated and indexed to storage`}
      actions={total ? <span className="chip chip--pill chip--emerald">{total} Total Captured</span> : undefined}
    >
      {rows.length === 0 ? (
        <p className="muted">No captures yet — recordings land here once a meeting wraps up.</p>
      ) : (
        <div className="sched-ses-list">
          {rows.map((s) => {
            const failed = s.stage === "failed";
            const archived = !failed && !s.mp4;
            const sec = secOf(s.title);
            const size = humanMB(s.sizeMB);
            const href = sessionHref(s);
            return (
              <div key={s.stem} className="sched-ses-row">
                <div className="sched-ses-main">
                  {failed ? (
                    <ExclamationTriangleIcon className="heroicon" style={{ color: "var(--error)", flex: "none", marginTop: 2 }} />
                  ) : (
                    <CheckCircleIcon className="heroicon" style={{ color: "var(--primary)", flex: "none", marginTop: 2 }} />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div className="sched-ses-title-row">
                      <span className="sched-ses-title" title={s.title}>{s.title}</span>
                      {sec && <span className="code-chip">SEC. {sec}</span>}
                      {s.segCount ? <span className="code-chip" style={{ color: "var(--tertiary)" }}>seg {s.segCount}</span> : null}
                      {archived && <span className="code-chip">raw stream kept</span>}
                    </div>
                    <div className="sched-ses-meta">
                      <span>{new Date(s.updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}</span>
                      {size && <><span>·</span><span>{size} {s.mp4?.endsWith(".webm") ? ".webm" : s.mp4 ? ".mp4" : ""}</span></>}
                      {failed && s.stageNote && <><span>·</span><span>{s.stageNote.slice(0, 60)}</span></>}
                    </div>
                  </div>
                </div>
                <div className="sched-ses-side">
                  {failed ? (
                    <Badge variant="red">Failed</Badge>
                  ) : archived ? (
                    <Badge variant="neutral">Archived</Badge>
                  ) : (
                    <Badge variant="emerald">Done</Badge>
                  )}
                  {href && (
                    <Link className="sched-folder-btn" href={href} title="Open session — notes & transcript">
                      <FolderOpenIcon className="heroicon" />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
