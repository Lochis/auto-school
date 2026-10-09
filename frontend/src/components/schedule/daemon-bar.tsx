"use client";

import { useEffect, useState } from "react";
/** Daemon hero status bar (stitch screen 5): state pill, next scheduled
 *  session, last-scan telemetry, and the pause/reset/scan quick triggers.
 *  Wired to the SAME /api/backend endpoints the footer BackendBar uses —
 *  this is the dashboard-side mirror, not a replacement. */
import { useRouter } from "next/navigation";
import { useStatus, tick, type Status } from "@/lib/use-status";
import { clock } from "@/lib/format";
import type { CalEvent } from "@/lib/calendar-shared";
import { GhostButton, LiveDot, PrimaryButton } from "@/components/ui";
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ClockIcon,
  PauseCircleIcon,
  PlayCircleIcon,
} from "@heroicons/react/24/outline";

/** fields the daemon's /status returns that the shared Status type doesn't
 *  spell out yet (schedule = the daemon's live auto-join window) */
export interface SchedStatus extends Status {
  schedule?: { title: string; start: string; end: string }[];
  handled?: string[];
}

/** the next session the daemon will act on — its own schedule first, the
 *  calendar scan dump as fallback */
export function nextUp(s: SchedStatus | null, events: CalEvent[], now: Date): { title: string; start: string | Date } | null {
  const fromSched = (s?.schedule ?? [])
    .slice()
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .find((e) => Date.parse(e.end) > now.getTime());
  if (fromSched) return { title: fromSched.title, start: fromSched.start };
  const ev = events
    .filter((e) => e.online && new Date(e.end).getTime() > now.getTime())
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[0];
  return ev ? { title: ev.title, start: ev.start } : null;
}

export default function DaemonBar({ events }: { events: CalEvent[] }) {
  const status = useStatus() as SchedStatus | null;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const router = useRouter();

  // 15s clock so "next up" flips the moment a session starts/ends
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  const online = status?.online !== false;
  const state = online ? (status?.activity ?? status?.state ?? "idle") : "offline";
  const next = nextUp(status, events, now);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/backend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setMsg((await r.json()).note ?? null);
      tick();
      if ("reset" in body) setTimeout(() => router.refresh(), 4000);
    } catch {
      setMsg("backend unreachable");
    }
    setBusy(false);
  };

  return (
    <section className="panel sched-daemon" aria-label="Daemon status">
      <div className="sched-daemon-left">
        <span className={`sched-state-pill ${online ? "" : "sched-state-pill--offline"}`}>
          <LiveDot static={!online} tone={online ? "emerald" : "red"} />
          <span className="sched-state-label">Daemon {state}</span>
        </span>
        <div className="sched-upnext">
          <div className="sched-upnext-row">
            <span className="eyebrow">Scheduled session next</span>
            {next ? (
              <span className="code-chip">
                {new Date(next.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                {" · "}
                {clock(next.start)}
              </span>
            ) : (
              <span className="muted" style={{ fontSize: "0.75rem" }}>nothing queued</span>
            )}
          </div>
          {next && (
            <span className="sched-upnext-title" title={next.title}>
              {next.title}
            </span>
          )}
        </div>
      </div>

      <div className="sched-daemon-actions">
        {status?.lastScan && (
          <span className="sched-lastscan">
            <ClockIcon className="heroicon" style={{ display: "inline" }} />
            Last scan: <strong>{clock(status.lastScan)}</strong>
          </span>
        )}
        <GhostButton
          onClick={() => post({ paused: !status?.joinPaused })}
          disabled={busy}
          title={status?.joinPaused ? "Resume automatic joining" : "Pause joining — daemon will NOT enter meetings (absence mode)"}
          icon={status?.joinPaused ? <PlayCircleIcon className="heroicon" /> : <PauseCircleIcon className="heroicon" />}
        >
          {status?.joinPaused ? "Resume Joining" : "Pause Joining"}
        </GhostButton>
        <GhostButton
          onClick={() => post({ reset: true })}
          disabled={busy}
          title="Rescan now AND re-attend already-handled titles"
          icon={<ArrowUturnLeftIcon className="heroicon" />}
        >
          Reset Scan
        </GhostButton>
        <PrimaryButton
          onClick={() => post({ reset: false })}
          disabled={busy}
          title="Rescan now, skip handled titles"
          icon={<ArrowPathIcon className="heroicon" />}
        >
          Manual Scan
        </PrimaryButton>
        {msg && <span className="muted" style={{ fontSize: "0.75rem" }}>{msg.slice(0, 60)}</span>}
      </div>
    </section>
  );
}
