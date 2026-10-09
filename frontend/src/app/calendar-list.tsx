"use client";
/** Calendar panel (stitch screen 5): Day View timeline strip (6:00→24:00,
 *  course-colored blocks, red now-needle) + agenda grouped by day with
 *  counts, attended/persisted badges and the highlighted Autopilot Target
 *  row. Live join-state + Join/Leave flows poll /api/backend via the shared
 *  status hook; the event list itself comes from the server scan dump. */
import { useEffect, useState } from "react";
import type { CalEvent } from "@/lib/calendar-shared";
import { evState, stripPos } from "@/lib/calendar-shared";
import JoinLeaveButtons from "./join-leave-buttons";
import { useStatus } from "@/lib/use-status";
import { clock } from "@/lib/format";
import { Badge, Chip, Panel, SegmentedTabs } from "@/components/ui";
import type { SchedStatus } from "@/components/schedule/daemon-bar";
import {
  ArrowPathIcon,
  CalendarDaysIcon,
  CheckIcon,
  Cog6ToothIcon,
  ExclamationCircleIcon,
} from "@heroicons/react/24/outline";

const fmt = (d: Date | string) =>
  new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

/** "SEC. 402" chip value from a meeting title, if present */
const secOf = (t: string) => t.match(/\bSEC?[.\s]*(\d{3})\b/i)?.[1] ?? null;
/** lab-type meeting → cyan chip (derived from the title text) */
const isLab = (t: string) => /\blab\b/i.test(t);
/** stable per-course color key: the prefix before an em-dash, else the title */
const courseKey = (t: string) => t.split("—")[0].trim().toLowerCase();

type View = "day" | "range";

export default function CalendarList({ events, asOf }: { events: CalEvent[]; asOf: string | null }) {
  const status = useStatus() as SchedStatus | null;
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<View>("day");

  useEffect(() => {
    const b = setInterval(() => setNow(new Date()), 15_000); // keep live/past fresh
    return () => clearInterval(b);
  }, []);

  const attendingTitle = status?.state?.startsWith("attending: ")
    ? status.state.slice("attending: ".length) : null;
  const attendedSet = new Set(status?.attended ?? []);
  const joinedTo = (t: string) => attendingTitle === t || attendedSet.has(t);

  const today = events.filter((e) => new Date(e.start).toDateString() === now.toDateString());
  const days = Array.from(new Set(events.map((e) => new Date(e.start).toDateString())))
    .filter((d) => new Date(d) >= new Date(now.toDateString())) // today and later only
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  // the one meeting the daemon will auto-join next (skip already-handled titles)
  const handled = new Set(status?.handled ?? []);
  const targetTitle = !status?.joinPaused
    ? events
        .filter((e) => e.online && !handled.has(e.title) && new Date(e.end).getTime() > now.getTime())
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[0]?.title
    : undefined;

  // alternating per-course block colors on the timeline strip
  const courseTone = new Map<string, "emerald" | "indigo">();
  for (const e of today) {
    const k = courseKey(e.title);
    if (!courseTone.has(k)) courseTone.set(k, courseTone.size % 2 === 0 ? "emerald" : "indigo");
  }

  const nowLeft = ((Math.min(Math.max(now.getHours() * 60 + now.getMinutes(), 360), 1440) - 360) / 1080) * 100;
  const shownDays = view === "day" ? days.slice(0, 1) : days;

  return (
    <Panel
      className="sched-calendar"
      icon={<CalendarDaysIcon className="heroicon" />}
      title={`Calendar — ${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`}
      subtitle={
        asOf
          ? `${today.length} session${today.length === 1 ? "" : "s"} scheduled today · scanned ${clock(asOf)}`
          : undefined
      }
      actions={
        <SegmentedTabs
          items={[
            { label: "Day View", active: view === "day", onClick: () => setView("day") },
            { label: "3-Day Range", active: view === "range", onClick: () => setView("range") },
          ]}
        />
      }
    >
      {status?.graph && (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: "0.75rem", display: "inline-flex", alignItems: "center", gap: 4 }}>
          <CheckIcon className="heroicon" style={{ display: "inline", color: "var(--primary)" }} /> Graph live schedule
        </p>
      )}
      {status?.graphCode && (
        <p className="callout" style={{ margin: "0 0 10px" }}>
          <ExclamationCircleIcon className="heroicon" style={{ flex: "none", marginTop: 2 }} />
          <span>
            Approve the one-time login: open{" "}
            <a href={status.graphCode.uri} target="_blank" rel="noreferrer">{status.graphCode.uri.replace("https://", "")}</a>{" "}
            and enter code <code>{status.graphCode.code}</code>
          </span>
        </p>
      )}

      {!asOf ? (
        <p className="muted">No scan data yet — hit Manual Scan, or wait for the next poll.</p>
      ) : (
        <>
          {/* Day View: 6:00–24:00 timeline strip */}
          <div className="timeline">
            {[6, 9, 12, 15, 18, 21].map((h) => (
              <div key={h} className="timeline-tick" style={{ left: `${((h * 60 - 360) / 1080) * 100}%` }}>
                <span>{((h + 11) % 12) + 1} {h < 12 ? "AM" : "PM"}</span>
              </div>
            ))}
            <div className="timeline-now" style={{ left: `${nowLeft}%` }} title="now" />
            {today.map((ev, i) => {
              const { left, width } = stripPos(ev);
              const st = evState(ev, now);
              const joined = joinedTo(ev.title);
              const tone = st === "past" && !joined ? "past" : courseTone.get(courseKey(ev.title));
              return (
                <div
                  key={i}
                  className={`timeline-event timeline-event--${tone}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${joined ? "joined — " : ""}${ev.title}\n${fmt(ev.start)} – ${fmt(ev.end)}`}
                />
              );
            })}
          </div>
          <div className="sched-cal-legend">
            <span><span className="sched-swatch sched-swatch--emerald" /> Past attended classes</span>
            <span><span className="sched-swatch sched-swatch--red" /> Current time indicator ({clock(now)})</span>
          </div>

          {/* agenda list — Day View shows today only, 3-Day Range the scan window */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-lg)", marginTop: "var(--space-lg)" }}>
            {shownDays.map((day) => {
              const dayEvents = events.filter((e) => new Date(e.start).toDateString() === day);
              const isToday = day === now.toDateString();
              const pastCount = dayEvents.filter((e) => evState(e, now) === "past").length;
              const count = isToday
                ? pastCount > 0 ? `${pastCount} session${pastCount === 1 ? "" : "s"} completed` : `${dayEvents.length} scheduled`
                : `${dayEvents.length} upcoming class${dayEvents.length === 1 ? "" : "es"}`;
              return (
                <div key={day} className="sched-day-group">
                  <div className="sched-day-head">
                    <span className={`sched-day-label ${isToday ? "" : "sched-day-label--future"}`}>
                      {isToday
                        ? `Today — ${new Date(day).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`
                        : new Date(day).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                    </span>
                    <span className="chip chip--pill">{count}</span>
                  </div>
                  <ul className="sched-agenda-list">
                    {dayEvents.map((ev, i) => {
                      const st = evState(ev, now);
                      const joined = joinedTo(ev.title);
                      const isTarget = ev.title === targetTitle;
                      const sec = secOf(ev.title);
                      const live = attendingTitle === ev.title;
                      return (
                        <li
                          key={i}
                          className={`sched-agenda-row ${isTarget ? "sched-agenda-row--target" : ""}`}
                        >
                          <div className="sched-agenda-main">
                            <span
                              className={`sched-agenda-marker ${st === "past" && joined ? "sched-agenda-marker--done" : live ? "sched-agenda-marker--live" : ""}`}
                              title={st === "past" && joined ? "attended — persisted" : st}
                            >
                              {st === "past" && joined ? (
                                <CheckIcon className="heroicon" style={{ display: "inline", width: 12, height: 12 }} />
                              ) : st === "past" ? (
                                <CheckIcon className="heroicon" style={{ display: "inline", width: 12, height: 12, opacity: 0.4 }} />
                              ) : (
                                i + 1
                              )}
                            </span>
                            <span className={`sched-agenda-time ${isTarget ? "sched-agenda-time--target" : st === "past" ? "sched-agenda-time--muted" : ""}`}>
                              {fmt(ev.start)} – {fmt(ev.end)}
                            </span>
                            <span className="sched-agenda-title-wrap">
                              <span className={`sched-agenda-title ${st === "past" && !joined ? "sched-agenda-title--muted" : ""}`}>
                                {ev.title}
                              </span>
                              {sec && <span className="code-chip">SEC. {sec}</span>}
                              {isLab(ev.title) && <Chip tone="cyan">Lab Session</Chip>}
                              {isTarget && <Chip tone="emerald" pill><Cog6ToothIcon className="heroicon" style={{ display: "inline", width: 11, height: 11 }} /> Autopilot Target</Chip>}
                              {!ev.online && <span className="muted" style={{ fontSize: "0.75rem" }}>(in-person / not online)</span>}
                            </span>
                          </div>
                          <div className="sched-agenda-side">
                            {ev.online && isToday && (
                              <JoinLeaveButtons
                                title={ev.title}
                                joined={attendingTitle === ev.title} // Leave ONLY while actually in the meeting
                                compact
                              />
                            )}
                            {live ? (
                              <Badge variant="red"><ArrowPathIcon className="heroicon" style={{ display: "inline", width: 11, height: 11 }} /> recording now</Badge>
                            ) : joined ? (
                              <span className="sched-badge-persisted">
                                <Cog6ToothIcon className="heroicon" style={{ display: "inline", width: 11, height: 11 }} />
                                attended — persisted
                              </span>
                            ) : isTarget ? (
                              <span className="code-chip" style={{ background: "var(--surface-container)" }}>not joined · queued</span>
                            ) : (
                              <span className="code-chip" style={{ background: "var(--surface-container)", color: "var(--outline)" }}>not joined</span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                    {dayEvents.length === 0 && <li className="muted">nothing</li>}
                  </ul>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}
