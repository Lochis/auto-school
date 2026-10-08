"use client";
/** Live daemon-listener telemetry card (right rail of the courses screen).
 *  Reuses the shared /api/backend poller; emerald pulse while the daemon
 *  answers, red static dot when it is unreachable. */
import { MicrophoneIcon } from "@heroicons/react/24/outline";
import { useStatus } from "@/lib/use-status";
import { LiveDot } from "@/components/ui";

export default function DaemonCard() {
  const st = useStatus();
  const online = !!st && st.online !== false && st.state !== "offline";
  const state = online ? (st?.activity || st?.state || "idle") : "daemon offline — retrying";
  return (
    <div className="daemon-card">
      <span className={`icon-tile ${online ? "icon-tile--emerald" : "icon-tile--red"}`}>
        <MicrophoneIcon className="heroicon" />
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: "var(--on-surface)" }}>
          Whisper Daemon Listener
        </span>
        <span className="daemon-card-sub" title={state}>
          Auto-extracting tasks from 48kHz audio streams — {state}
        </span>
      </div>
      <LiveDot tone={online ? "emerald" : "red"} static={!online} />
    </div>
  );
}
