"use client";

import { useEffect, useState } from "react";

/** Settings panel — currently: transcription on/off (Gemini quota guard).
 *  Persisted by the backend in <data>/settings.json; applies to the very
 *  next segment — no restart needed. */
export default function SettingsPanel() {
  const [transcribe, setTranscribe] = useState<boolean | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy2, setBusy2] = useState(false);
  const [msg2, setMsg2] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => { setTranscribe(!!s.transcribe); setOffline(!!s.offline); })
      .catch(() => setOffline(true));
  }, []);

  const toggle = async () => {
    const next = !transcribe;
    setTranscribe(next); // optimistic
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcribe: next }),
      });
      const s = await r.json();
      if (typeof s.transcribe === "boolean") setTranscribe(s.transcribe);
      if (s.offline) setOffline(true);
    } catch {
      setOffline(true);
    }
  };

  const purgeSegments = async () => {
    if (!confirm("Delete ALL raw segment files?\nConsolidated mp4s are not touched.")) return;
    setBusy2(true);
    try {
      const r = await fetch("/api/segments", { method: "DELETE" });
      const j = await r.json();
      setMsg2(j.removed != null ? `removed ${j.removed} file(s)` : String(j.error ?? "failed"));
    } catch {
      setMsg2("backend unreachable");
    }
    setBusy2(false);
  };

  return (
    <div className="card">
      <h2 style={{ margin: "0 0 6px" }}>Settings</h2>
      <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={transcribe ?? true}
          onChange={toggle}
          disabled={transcribe === null}
          style={{ width: 18, height: 18 }}
        />
        <span>
          Transcribe &amp; summarize (Gemini)
          <span className="muted" style={{ display: "block" }}>
            {transcribe === null ? "loading…"
              : offline ? "backend offline — change may not have saved"
              : transcribe ? "ON — model chain transcribes + notes segments as they close (auto-fails over on quota)"
              : "OFF — recordings only (mp4 kept, no API usage)"}
          </span>
        </span>
      </label>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
        <button onClick={purgeSegments} disabled={busy2} title="TEST: remove all raw webm/ogg segments (mp4s stay)">
          Purge raw segments
        </button>
        {msg2 && <span className="muted">{msg2}</span>}
      </div>
    </div>
  );
}
