"use client";
/** Activity Stream panel (stitch screen 5): the daemon's event log rendered
 *  as a dark terminal well. Source tags ([schedule] [mux] [gemini] …) are
 *  derived client-side from the event message text — the daemon prefixes
 *  its events consistently, so the mapping below is stable. */
import { useStatus, type Status } from "@/lib/use-status";
import { LiveDot, Panel } from "@/components/ui";
import { CommandLineIcon } from "@heroicons/react/24/outline";

interface Ev { ts: string; msg: string }

type TagTone = "indigo" | "cyan" | "emerald" | "red" | "neutral";

/** first matching rule wins — order is significant */
const TAG_RULES: { re: RegExp; tag: string; tone: TagTone }[] = [
  { re: /^deadlines?\b|checklist|deadline tool/i, tag: "deadlines", tone: "indigo" },
  { re: /schedule built|scan|cron|graph|gave up joining|not joinable|session expired/i, tag: "schedule", tone: "cyan" },
  { re: /segment|consolidat|remux|orphan|quarantin/i, tag: "mux", tone: "emerald" },
  { re: /notes|summary/i, tag: "ai-notes", tone: "indigo" },
  { re: /gemini|transcribe|quota|model|chat tool/i, tag: "gemini", tone: "cyan" },
  { re: /join|leave|meeting|recording|browser|manual/i, tag: "meeting", tone: "red" },
];

function tagOf(msg: string): { tag: string; tone: TagTone } {
  for (const r of TAG_RULES) if (r.re.test(msg)) return { tag: r.tag, tone: r.tone };
  return { tag: "ops", tone: "neutral" };
}

const hhmmss = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour12: false });

export default function ActivityStream() {
  const status = useStatus();
  const events = ((status?.events ?? []) as Ev[]).slice(0, 14);
  const online = status?.online !== false;

  return (
    <Panel
      icon={<CommandLineIcon className="heroicon" />}
      title="Activity Stream"
      subtitle="Daemon event log & Gemini pipeline"
      actions={
        <span className="eyebrow eyebrow--emerald" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <LiveDot static={!online} /> {online ? "LIVE" : "OFFLINE"}
        </span>
      }
    >
      <div className="sched-log" role="log" aria-live="polite">
        {events.length === 0 ? (
          <span className="sched-log-empty">no events yet — the daemon logs every pipeline step here</span>
        ) : (
          events.map((e) => {
            const { tag, tone } = tagOf(e.msg);
            return (
              <div key={e.ts + e.msg} className="sched-log-line">
                <span className="sched-log-time">{hhmmss(e.ts)}</span>
                <span className={`sched-log-tag sched-log-tag--${tone}`}>[{tag}]</span>
                <span className="sched-log-msg">{e.msg}</span>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}
