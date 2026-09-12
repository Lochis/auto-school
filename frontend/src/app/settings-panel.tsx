"use client";

import { useEffect, useState } from "react";

/** Settings panel — every knob persisted by the backend in <data>/settings.json
 *  (on the Longhorn volume) and applied WITHOUT a restart: each consumer reads
 *  the setting at use time (per segment close, per request, per spawn).
 *  .env values only seed defaults on a fresh volume. */
interface KeyInfo { from: "settings" | "env" | null; hint: string | null }
interface AllSettings {
  transcribe: boolean;
  recordRetentionDays: number;
  batchSegments: number;
  transcribeBatch: number;
  geminiModels: string;
  joinEarlyMinutes: number;
  offline?: boolean;
  keys?: { gemini: KeyInfo; glm: KeyInfo; glmBase: string };
}

const FIELDS: { key: keyof AllSettings; label: string; min: number; max: number; hint: string }[] = [
  { key: "recordRetentionDays", label: "Keep recordings for", min: 0, max: 3650,
    hint: "days · 0 = forever · videos only — transcripts & notes always stay" },
  { key: "batchSegments", label: "Live batch size", min: 1, max: 6,
    hint: "segments per Gemini request during class (quota is per-DAY requests)" },
  { key: "transcribeBatch", label: "Manual batch size", min: 1, max: 9,
    hint: "audio chunks per request when re-transcribing from the course page" },
  { key: "joinEarlyMinutes", label: "Join early", min: 0, max: 30,
    hint: "minutes before class start to join the meeting" },
];

export default function SettingsPanel() {
  const [s, setS] = useState<AllSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // key drafts: empty = leave as-is; typed = override; cleared flag = remove override
  const [keyDrafts, setKeyDrafts] = useState<{ gemini: string; glm: string; glmBase: string }>({ gemini: "", glm: "", glmBase: "" });
  const [keyDirty, setKeyDirty] = useState<{ gemini: boolean; glm: boolean; glmBase: boolean }>({ gemini: false, glm: false, glmBase: false });

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((v: AllSettings) => setS(v))
      .catch(() => setS({ ...({} as AllSettings), offline: true, transcribe: true,
        recordRetentionDays: 30, batchSegments: 4, transcribeBatch: 9,
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

  const save = async (): Promise<void> => {
    if (!s) return;
    setBusy(true);
    const v = await put({
      recordRetentionDays: s.recordRetentionDays,
      batchSegments: s.batchSegments,
      transcribeBatch: s.transcribeBatch,
      joinEarlyMinutes: s.joinEarlyMinutes,
      ...(s.geminiModels.trim() ? { geminiModels: s.geminiModels } : {}),
      // keys: only send fields the user touched ("" = clear override → env)
      ...(keyDirty.gemini ? { geminiApiKey: keyDrafts.gemini } : {}),
      ...(keyDirty.glm ? { glmApiKey: keyDrafts.glm } : {}),
      ...(keyDirty.glmBase ? { glmBase: keyDrafts.glmBase } : {}),
    });
    if (v && !v.offline) {
      setS(v);
      setDirty(false);
      setKeyDirty({ gemini: false, glm: false, glmBase: false });
      setKeyDrafts({ gemini: "", glm: "", glmBase: v.keys?.glmBase ?? "" });
      setMsg("saved — applies immediately");
    }
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

        <h3 style={{ margin: "18px 0 2px", fontSize: 15 }}>API keys</h3>
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
          Stored on the data volume and applied without a restart. A value typed here overrides the environment;
          clearing a field (empty + Save) falls back to it. Keys are never shown back in full.
        </p>
        {([
          { id: "gemini" as const, label: "Gemini API key", info: s.keys?.gemini, type: "password", ph: "AIza…" },
          { id: "glm" as const, label: "GLM API key", info: s.keys?.glm, type: "password", ph: "Zhipu coding-plan key…" },
          { id: "glmBase" as const, label: "GLM base URL", type: "text", ph: "https://open.bigmodel.cn/api/coding/paas/v4" },
        ]).map((f) => {
          const cur = f.id === "glmBase" ? (s.keys?.glmBase ?? "") : undefined;
          return (
            <div key={f.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "3px 0" }}>
              <label htmlFor={`key-${f.id}`} style={{ fontWeight: 600, minWidth: 150 }}>{f.label}</label>
              <input
                id={`key-${f.id}`}
                type={f.type}
                autoComplete="off"
                style={{ width: 330, fontFamily: f.id === "glmBase" ? "inherit" : "monospace" }}
                placeholder={f.id === "glmBase" ? (cur || f.ph) : f.info?.from ? `currently from ${f.info.from} (${f.info.hint}) — type to override` : f.ph}
                value={f.id === "glmBase" ? (keyDirty.glmBase ? keyDrafts.glmBase : (s.keys?.glmBase ?? "")) : keyDrafts[f.id]}
                onChange={(e) => {
                  setKeyDrafts((m) => ({ ...m, [f.id]: e.target.value }));
                  setKeyDirty((m) => ({ ...m, [f.id]: true }));
                  setDirty(true);
                }}
              />
              {f.info && f.info.from && (
                <span className="muted" style={{ fontSize: 12 }}>
                  set: {f.info.from} {f.info.hint ?? ""}{f.info.from === "settings" ? " — clear field + Save to fall back to env" : ""}
                </span>
              )}
            </div>
          );
        })}
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
