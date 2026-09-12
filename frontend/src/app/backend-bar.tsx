"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useStatus, tick, type Status } from "@/lib/use-status";
import { clock } from "@/lib/format";

/** turn "out/fail-XXXXXX.png" mentions into viewable screenshot links */
function linkShots(msg: string): React.ReactNode {
  const m = msg.match(/out\/(fail-[\w-]+\.png)/);
  if (!m) return msg;
  const [head, tail] = msg.split(m[0]);
  return <>{head}<a href={`/api/media/out/${m[1]}`} target="_blank" rel="noreferrer" style={{ color: "#8ab4ff" }}>📸 {m[1]}</a>{tail}</>;
}

const STAGE_ICON: Record<string, string> = {
  recording: "⏺", remuxing: "⏳", transcribing: "✎️", noting: "📝", consolidating: "🎬", done: "✅", failed: "⚠️",
};

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
  const chips: string[] = Object.entries(status?.detail ?? {})
    .filter(([k]) => k !== "meeting")
    .map(([k, v]) => `${k}: ${v}`);

  return (
    <div className="card">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>
          {online ? `● ${status?.activity ?? status?.state ?? "…"}` : "○ backend offline"}
        </span>
        <span style={{ flex: 1 }} />
        {status?.lastScan && <span className="muted">scanned {clock(status.lastScan!)}</span>}
        <button onClick={() => scan(true)} disabled={busy} title="Rescan now AND re-attend already-handled titles">Scan (reset)</button>
        <button onClick={() => scan(false)} disabled={busy} title="Rescan now, skip handled titles">Scan</button>
      </div>

      {(status?.degraded ?? []).length > 0 && (
        <div style={{ margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
          {status!.degraded!.map((d) => (
            <p key={d} style={{ margin: 0, padding: "4px 10px", borderRadius: 6, background: "rgba(255,196,84,0.08)", border: "1px solid rgba(255,196,84,0.25)" }}>
              ⚠️ {d}
            </p>
          ))}
        </div>
      )}
      {status?.detail?.meeting && (
        <p className="muted" style={{ margin: "6px 0 0" }}>meeting: {String(status.detail.meeting)}</p>
      )}
      {chips.length > 0 && (
        <p className="muted" style={{ margin: "6px 0 0" }}>{chips.join("  ·  ")}</p>
      )}
      {(status?.sessions ?? []).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <strong>Sessions</strong>
          <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
            {status!.sessions!.slice(0, 6).map((s) => (
              <li key={s.stem} className="muted" style={{ margin: "2px 0", fontSize: 13 }}>
                {STAGE_ICON[s.stage] ?? "•"}{" "}
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
      {msg && <p className="muted" style={{ margin: "6px 0 0" }}>{msg}</p>}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 10 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <strong>Up next</strong>
          <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
            {upNext(status).map((t) => <li key={t} className="muted" style={{ margin: "2px 0" }}>{t}</li>)}
          </ul>
        </div>
        <div style={{ flex: 1.4, minWidth: 280 }}>
          <strong>Activity</strong>
          <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
            {(status?.events ?? []).slice(0, 8).map((e, i) => (
              <li key={e.ts + e.msg} className="muted" style={{ margin: "2px 0" }}>
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
    </div>
  );
}
