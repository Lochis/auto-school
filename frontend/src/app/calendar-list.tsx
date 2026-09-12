"use client";

import { useEffect, useState } from "react";
import type { CalEvent } from "@/lib/calendar-shared";
import { evState, stripPos } from "@/lib/calendar-shared";
import JoinLeaveButtons from "./join-leave-buttons";
import { useStatus } from "@/lib/use-status";
import { clock } from "@/lib/format";

interface Ev { ts: string; msg: string }

const fmt = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

/** Calendar with live join-state: ● recording now / ✓ attended / — not joined.
 *  Polls the daemon (via the frontend proxy) so the badge flips the moment the
 *  bot joins or leaves. */
export default function CalendarList({ events, asOf }: { events: CalEvent[]; asOf: string | null }) {
  const status = useStatus();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const b = setInterval(() => setNow(new Date()), 15_000); // keep live/past fresh
    return () => clearInterval(b);
  }, []);

  const attendingTitle = status?.state?.startsWith("attending: ")
    ? status.state.slice("attending: ".length) : null;
  const attendedSet = new Set(status?.attended ?? []);
  const joinedTo = (t: string) => attendingTitle === t || attendedSet.has(t);
  const today = events.filter((e) => new Date(e.start).toDateString() === now.toDateString());
  // full calendar: today + upcoming days (scan window is 7 days with Graph)
  const days = Array.from(new Set(events.map((e) => new Date(e.start).toDateString())))
    .filter((d) => new Date(d) >= new Date(now.toDateString())) // today and later only
    .sort();
  const nowLeft = ((Math.min(Math.max(now.getHours() * 60 + now.getMinutes(), 360), 1440) - 360) / 1080) * 100;

  return (
    <div className="card">
      <h2 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        Calendar — {now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
        {status?.graph && <span className="muted" style={{ fontSize: 12 }}>Graph ✓ live schedule</span>}
      </h2>
      {status?.graphCode && (
        <p style={{ margin: "2px 0 8px", fontSize: 13 }}>
          Approve the one-time login: open{" "}
          <a href={status.graphCode.uri} target="_blank" rel="noreferrer">{status.graphCode.uri.replace("https://", "")}</a>{" "}
          and enter code <code style={{ background: "#1e1e1e", padding: "2px 8px", borderRadius: 4, fontSize: 14 }}>{status.graphCode.code}</code>
        </p>
      )}
      {!asOf ? (
        <p className="muted">No scan data yet — hit Scan, or wait for the next poll.</p>
      ) : (
        <>
          <p className="muted" style={{ margin: "4px 0 10px" }}>
            {today.length} event{today.length === 1 ? "" : "s"} today · scanned {clock(asOf)}
          </p>

          {/* 6:00–24:00 day strip */}
          <div className="cal-strip">
            {[6, 9, 12, 15, 18, 21].map((h) => (
              <div key={h} className="cal-tick" style={{ left: `${((h * 60 - 360) / 1080) * 100}%` }}>
                <span>{((h + 11) % 12) + 1} {h < 12 ? "AM" : "PM"}</span>
              </div>
            ))}
            <div className="cal-now" style={{ left: `${nowLeft}%` }} title="now" />
            {today.map((ev, i) => {
              const { left, width } = stripPos(ev);
              const st = evState(ev, now);
              const joined = joinedTo(ev.title);
              return (
                <div key={i}
                  className={`cal-ev ${st}${joined ? " joined" : ""}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${joined ? "⚙️ joined — " : ""}${ev.title}\n${fmt(ev.start)} – ${fmt(ev.end)}`} />
              );
            })}
          </div>

          {days.map((day) => {
            const dayEvents = events.filter((e) => new Date(e.start).toDateString() === day);
            const isToday = day === now.toDateString();
            return (
              <div key={day} style={{ marginTop: 16 }}>
                <strong style={{ fontSize: 14 }}>
                  {isToday ? "Today" : new Date(day).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
                </strong>
                <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
            {dayEvents.map((ev, i) => {
              const st = evState(ev, now);
              const joined = joinedTo(ev.title);
              return (
                <li key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", margin: "6px 0", flexWrap: "wrap" }}>
                  <span className={`cal-badge ${st}`}>
                    {st === "live" ? "● LIVE" : st === "upcoming" ? "○ soon" : "✓ done"}
                  </span>
                  <span className="muted" style={{ minWidth: 130 }}>{fmt(ev.start)} – {fmt(ev.end)}</span>
                  <span style={{ opacity: st === "past" ? 0.55 : 1, flex: 1, minWidth: 160 }}>
                    {ev.title} {!ev.online && <span className="muted">(not online)</span>}
                  </span>
                  {ev.online && isToday && (
                    <JoinLeaveButtons
                      title={ev.title}
                      joined={attendingTitle === ev.title} // Leave ONLY while actually in the meeting
                      compact
                    />
                  )}
                  <span
                    className="muted"
                    style={{
                      color: attendingTitle === ev.title ? "#ff8a8a" : joined ? "#7ddc9a" : undefined,
                    }}
                  >
                    {attendingTitle === ev.title ? "⚙️ recording now" : joined ? "⚙️ attended — persisted" : "— not joined"}
                  </span>
                </li>
              );
            })}
            {dayEvents.length === 0 && <li className="muted">nothing</li>}
                </ul>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
