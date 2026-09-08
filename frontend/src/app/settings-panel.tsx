"use client";

import { useEffect, useState } from "react";

/** Settings panel — every knob persisted by the backend in <data>/settings.json
 *  (on the Longhorn volume) and applied WITHOUT a restart: each consumer reads
 *  the setting at use time (per segment close, per request, per spawn).
 *  .env values only seed defaults on a fresh volume. */
interface AllSettings {
  transcribe: boolean;
  recordRetentionDays: number;
  batchSegments: number;
  transcribeBatch: number;
  encThreads: number;
  geminiModels: string;
  joinEarlyMinutes: number;
  offline?: boolean;
}

const FIELDS: { key: keyof AllSettings; label: string; min: number; max: number; hint: string }[] = [
  { key: "recordRetentionDays", label: "Keep recordings for", min: 0, max: 3650,
    hint: "days · 0 = forever · videos only — transcripts & notes always stay" },
  { key: "batchSegments", label: "Live batch size", min: 1, max: 6,
    hint: "segments per Gemini request during class (quota is per-DAY requests)" },
  { key: "transcribeBatch", label: "Manual batch size", min: 1, max: 9,
    hint: "audio chunks per request when re-transcribing from the course page" },
  { key: "encThreads", label: "Encode threads", min: 1, max: 4,
    hint: "x264 threads for mp4 consolidation — lower = less CPU, slower" },
  { key: "joinEarlyMinutes", label: "Join early", min: 0, max: 30,
    hint: "minutes before class start to join the meeting" },
];

export default function SettingsPanel() {
  const [s, setS] = useState<AllSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((v: AllSettings) => setS(v))
      .catch(() => setS({ ...({} as AllSettings), offline: true, transcribe: true,
        recordRetentionDays: 30, batchSegments: 4, transcribeBatch: 9, encThreads: 2,
        geminiModels: "", joinEarlyMinutes: 3 }));
  }, []);

  const put = async (body: Record<string, unknown>): Promise<AllSettings | null> => {
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const v: AllSettings = await r.json();
      if (v.offline) setMsg("backend offline — change may not have saved");
      return v;
    } catch {
      setMsg("backend unreachable");
      return null;
    }
  };

  const toggle = async () => {
    if (!s) return;
    const next = !s.transcribe;
    setS({ ...s, transcribe: next }); // optimistic
    const v = await put({ transcribe: next });
    if (v && typeof v.transcribe === "boolean") setS({ ...v, offline: v.offline });
  };

  const save = async () => {
    if (!s) return;
    setBusy(true);
    const v = await put({
      recordRetentionDays: s.recordRetentionDays,
      batchSegments: s.batchSegments,
      transcribeBatch: s.transcribeBatch,
      encThreads: s.encThreads,
      joinEarlyMinutes: s.joinEarlyMinutes,
      ...(s.geminiModels.trim() ? { geminiModels: s.geminiModels } : {}),
    });
    if (v && !v.offline) { setS(v); setDirty(false); setMsg("saved — applies immediately"); }
    setBusy(false);
  };

  const purgeSegments = async () => {
    if (!confirm("Delete ALL raw segment files?\nConsolidated mp4s are not touched.")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/segments", { method: "DELETE" });
      const j = await r.json();
      setMsg(j.removed != null ? `removed ${j.removed} file(s)` : String(j.error ?? "failed"));
    } catch {
      setMsg("backend unreachable");
    }
    setBusy(false);
  };

  if (!s) return <div className="card"><h2 style={{ margin: "0 0 6px" }}>Settings</h2><p className="muted">loading…</p></div>;

  return (
    <div className="card">
      <h2 style={{ margin: "0 0 6px" }}>Settings</h2>

      <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={s.transcribe}
          onChange={toggle}
          style={{ width: 18, height: 18 }}
        />
        <span>
          Transcribe &amp; summarize (Gemini)
          <span className="muted" style={{ display: "block" }}>
            {s.offline ? "backend offline — change may not have saved"
              : s.transcribe ? "ON — model chain transcribes + notes segments as they close (auto-fails over on quota)"
              : "OFF — recordings only (mp4 kept, no API usage)"}
          </span>
        </span>
      </label>

      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {FIELDS.map((f) => (
          <div key={f.key} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label htmlFor={f.key} style={{ fontWeight: 600, minWidth: 150 }}>{f.label}</label>
            <input
              id={f.key}
              type="number" min={f.min} max={f.max} step={1} style={{ width: 70 }}
              value={s[f.key] as number}
              onChange={(e) => {
                const n = e.target.value === "" ? 0 : Math.max(f.min, Math.min(f.max, Number(e.target.value)));
                setS({ ...s, [f.key]: n }); setDirty(true);
              }}
            />
            <span className="muted">{f.hint}</span>
          </div>
        ))}

        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <label htmlFor="geminiModels" style={{ fontWeight: 600, minWidth: 150 }}>Gemini model chain</label>
          <textarea
            id="geminiModels"
            rows={2} style={{ flex: "1 1 320px", fontFamily: "inherit" }}
            value={s.geminiModels}
            onChange={(e) => { setS({ ...s, geminiModels: e.target.value }); setDirty(true); }}
          />
          <span className="muted" style={{ flexBasis: "100%" }}>
            comma-separated, tried in order until one isn&apos;t rate-limited — table below shows live quota state
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <button onClick={save} disabled={busy || !dirty}>Save changes</button>
        <button onClick={purgeSegments} disabled={busy} title="TEST: remove all raw webm/ogg segments (mp4s stay)">
          Purge raw segments
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  );
}
