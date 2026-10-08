"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useStatus, tick, type Status } from "@/lib/use-status";
import { clock } from "@/lib/format";
import { MicroButton } from "@/components/ui";
import {
  CameraIcon, CheckCircleIcon, ClockIcon, DocumentTextIcon, EllipsisHorizontalIcon,
  ExclamationTriangleIcon, FilmIcon, NoSymbolIcon, PauseIcon, PencilSquareIcon,
  PlayIcon, SignalIcon,
} from "@heroicons/react/24/outline";

/** turn "out/fail-XXXXXX.png" mentions into viewable screenshot links */
function linkShots(msg: string): React.ReactNode {
  const m = msg.match(/out\/(fail-[\w-]+\.png)/);
  if (!m) return msg;
  const [head, tail] = msg.split(m[0]);
  return <>{head}<a href={`/api/media/out/${m[1]}`} target="_blank" rel="noreferrer" style={{ color: "var(--secondary)" }}><CameraIcon className="heroicon" style={{ display: "inline" }} /> {m[1]}</a>{tail}</>;
}

const STAGE_ICON: Record<string, ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  recording: SignalIcon, remuxing: ClockIcon, transcribing: PencilSquareIcon, noting: DocumentTextIcon, consolidating: FilmIcon, done: CheckCircleIcon, failed: ExclamationTriangleIcon,
};

function StageIcon({ s }: { s: { stage: string } }): ReactNode {
  const K = STAGE_ICON[s.stage] ?? EllipsisHorizontalIcon;
  return <K className="heroicon" style={{ display: "inline" }} />;
}

/** What runs next, derived from the current phase — the "will be doing" list. */
function upNext(s: Status | null): string[] {
  if (s?.online === false) return ["backend unreachable — check the container"];
  const a = s?.activity ?? "";
  if (!s) return ["waiting for backend status…"];
  if (a.startsWith("joining")) return ["enter meeting (mic/cam off)", "start tab recording (video+audio)"];
  if (a.startsWith("in meeting")) return ["start tab recording (video+audio)"];
  if (a.startsWith("recording"))
    return [
      "segment closes every 5 min — Gemini batch fires per BATCH_SEGMENTS (default 4)",
      "running notes re-summarized after each batch",
      "on meeting end: remux tail → final notes → consolidate mp4 → delete raw segments",
    ];
  if (a.startsWith("post-processing"))
    return ["finalize notes", "consolidate segments → 720p mp4", "rebuild course index", "back to watching calendar"];
  return [
    "pull today's schedule (morning / on Scan)",
    "join + record the next live meeting automatically",
  ];
}

export default function BackendBar() {
  const status = useStatus();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const refresh = () => tick();

  const setPaused = async (paused: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/backend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      setMsg((await r.json()).note ?? null);
      refresh();
    } catch {
      setMsg("backend unreachable");
    }
    setBusy(false);
  };

  const scan = async (reset: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/backend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset }),
      });
      setMsg((await r.json()).note ?? "scan triggered");
      setTimeout(() => { refresh(); router.refresh(); }, 4000);
    } catch {
      setMsg("backend unreachable");
    }
    setBusy(false);
  };

  const online = status?.online !== false;
  const state = online
    ? (status?.activity ?? status?.state ?? "IDLE").toUpperCase()
    : "OFFLINE";
  const chips: string[] = Object.entries(status?.detail ?? {})
    .filter(([k]) => k !== "meeting")
    .map(([k, v]) => `${k}: ${v}`);

  // (⌘K quick-filter wiring is navbar-side)

  return (
    <div className="footer-shell">
      <footer className="footer-bar" role="contentinfo">
        <div className="footer-bar-side">
          {online ? (
            <span className="footer-mono" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="live-dot" style={{ width: 6, height: 6 }} />
              AUTOSCHOOL DAEMON // {state}
            </span>
          ) : (
            <span className="footer-mono footer-offline" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="live-dot live-dot--static" style={{ width: 6, height: 6, background: "var(--error)" }} />
              AUTOSCHOOL DAEMON // OFFLINE
            </span>
          )}
          {status?.joinPaused && (
            <span className="badge badge-red">
              <NoSymbolIcon className="heroicon" style={{ display: "inline", width: 12, height: 12 }} /> AUTO-JOIN PAUSED
            </span>
          )}
          <span>© 2025 AutoSchool Engine</span>
        </div>

        <div className="footer-bar-side">
          {status?.lastScan && <span className="footer-mono">LAST SCAN: {clock(status.lastScan!)}</span>}
          <MicroButton
            onClick={() => setPaused(!status?.joinPaused)}
            disabled={busy}
            title={status?.joinPaused ? "Resume automatic joining" : "Pause joining — daemon will NOT enter meetings (absence mode)"}
          >
            {status?.joinPaused ? (
              <><PlayIcon className="heroicon" style={{ display: "inline" }} /> Resume</>
            ) : (
              <><PauseIcon className="heroicon" style={{ display: "inline" }} /> Pause joining</>
            )}
          </MicroButton>
          <MicroButton onClick={() => scan(true)} disabled={busy} title="Rescan now AND re-attend already-handled titles">
            Scan (reset)
          </MicroButton>
          <MicroButton onClick={() => scan(false)} disabled={busy} title="Rescan now, skip handled titles">
            Scan
          </MicroButton>
        </div>
      </footer>

      {/* collapsible daemon detail drawer under the status bar */}
      <details className="footer-details">
        <summary>Daemon details — sessions, activity &amp; up next</summary>

        {(status?.degraded ?? []).length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
            {status!.degraded!.map((d) => (
              <p key={d} className="callout" style={{ margin: 0 }}>
                <ExclamationTriangleIcon className="heroicon" style={{ display: "inline", flex: "none" }} /> {d}
              </p>
            ))}
          </div>
        )}
        {msg && <p className="muted" style={{ margin: "8px 0 0" }}>{msg}</p>}
        {status?.detail?.meeting && (
          <p className="muted" style={{ margin: "8px 0 0" }}>meeting: {String(status.detail.meeting)}</p>
        )}
        {chips.length > 0 && (
          <p className="muted" style={{ margin: "8px 0 0" }}>{chips.join("  ·  ")}</p>
        )}

        {(status?.sessions ?? []).length > 0 && (
          <div style={{ marginTop: 12 }}>
            <strong style={{ fontSize: "0.8125rem" }}>Sessions</strong>
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
              {status!.sessions!.slice(0, 6).map((s) => (
                <li key={s.stem} className="muted" style={{ margin: "2px 0", fontSize: 13, fontFeatureSettings: '"tnum" 1' }}>
                  <StageIcon s={s} />{" "}
                  <span style={{ opacity: s.stage === "done" ? 0.7 : 1 }}>
                    {s.title}{s.segCount ? ` (seg ${s.segCount})` : ""}
                  </span>{" "}
                  — {s.stage}
                  {s.stageNote ? ` (${s.stageNote})` : ""}
                  {s.sizeMB ? ` · ${s.sizeMB} MB` : ""}
                  {" · "}<code style={{ background: "none", padding: 0 }}>{new Date(s.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 12 }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <strong style={{ fontSize: "0.8125rem" }}>Up next</strong>
            <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
              {upNext(status).map((t) => <li key={t} className="muted" style={{ margin: "2px 0" }}>{t}</li>)}
            </ul>
          </div>
          <div style={{ flex: 1.4, minWidth: 280 }}>
            <strong style={{ fontSize: "0.8125rem" }}>Activity</strong>
            <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
              {(status?.events ?? []).slice(0, 8).map((e, i) => (
                <li key={e.ts + e.msg} className="muted" style={{ margin: "2px 0", fontFeatureSettings: '"tnum" 1' }}>
                  <code style={{ background: "none", padding: 0 }}>
                    {new Date(e.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}
                  </code>{" "}{linkShots(e.msg)}
                </li>
              ))}
              {(!status?.events || status.events.length === 0) && (
                <li className="muted">no events yet</li>
              )}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}
