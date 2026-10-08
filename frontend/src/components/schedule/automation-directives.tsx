"use client";
/** Automation Directives panel (stitch screen 5): the two real automation
 *  switches the backend exposes —
 *   · Auto-Join & Record → joinPaused flag (POST /api/backend {paused} —
 *     the same endpoint the footer bar uses, so the poll loop wakes and the
 *     change takes effect immediately)
 *   · Live Transcribe & Summarize → transcribe flag (PUT /api/settings) */
import { useEffect, useState } from "react";
import { tick } from "@/lib/use-status";
import { Panel, Toggle } from "@/components/ui";
import { AdjustmentsHorizontalIcon } from "@heroicons/react/24/outline";

interface DaemonSettings {
  transcribe: boolean;
  joinPaused?: boolean;
  joinEarlyMinutes?: number;
  offline?: boolean;
}

export default function AutomationDirectives() {
  const [s, setS] = useState<DaemonSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((v: DaemonSettings) => setS(v))
      .catch(() => setS({ transcribe: true, offline: true }));
  }, []);

  const setJoin = async (autoJoin: boolean) => {
    if (!s || busy) return;
    setS({ ...s, joinPaused: !autoJoin }); // optimistic
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/backend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !autoJoin }),
      });
      setMsg((await r.json()).note ?? null);
      tick(); // sync every status consumer now
    } catch {
      setMsg("backend unreachable");
    }
    setBusy(false);
  };

  const setTranscribe = async (on: boolean) => {
    if (!s || busy) return;
    setS({ ...s, transcribe: on }); // optimistic
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcribe: on }),
      });
      const v: DaemonSettings = await r.json();
      if (v.offline) setMsg("backend offline — change may not have saved");
      else setS(v);
    } catch {
      setMsg("backend unreachable");
    }
    setBusy(false);
  };

  const early = s?.joinEarlyMinutes;

  return (
    <Panel
      icon={<AdjustmentsHorizontalIcon className="heroicon" />}
      title="Automation Directives"
      subtitle="Configure daemon polling triggers and automated meeting attendance"
    >
      <div className="sched-directives">
        <div className="sched-directive">
          <div>
            <span className="sched-directive-label">Auto-Join &amp; Record Next Call</span>
            <p className="sched-directive-hint">
              {early !== undefined && early > 0
                ? `Injects the audio tap and joins ${early} min before class start`
                : "Injects the audio tap at the class start timestamp"}
            </p>
          </div>
          <Toggle
            checked={s ? !s.joinPaused : false}
            onChange={setJoin}
            title={s?.joinPaused ? "Resume automatic joining" : "Pause joining — daemon will NOT enter meetings (absence mode)"}
          />
        </div>
        <div className="sched-directive">
          <div>
            <span className="sched-directive-label">Live Transcribe &amp; Summarize</span>
            <p className="sched-directive-hint">Gemini batches each segment while class is in session</p>
          </div>
          <Toggle
            checked={s?.transcribe ?? false}
            onChange={setTranscribe}
            title="Toggle the transcription + notes pipeline (quota guard)"
          />
        </div>
      </div>
      {(msg || s?.offline) && (
        <p className="muted" style={{ margin: "10px 0 0", fontSize: "0.75rem" }}>
          {msg ?? "backend offline — showing seeded defaults"}
        </p>
      )}
    </Panel>
  );
}
