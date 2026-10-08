"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRightIcon,
  BoltIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleStackIcon,
  InformationCircleIcon,
  KeyIcon,
  LinkIcon,
  LockClosedIcon,
  MicrophoneIcon,
  QuestionMarkCircleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { Badge, Eyebrow, LiveDot, MicroButton, Panel, PrimaryButton, Stepper, Toggle } from "@/components/ui";
import "../../app/settings-ui.css";

/** Settings & Automation Engine — every knob persisted by the backend in
 *  <data>/settings.json (on the Longhorn volume) and applied WITHOUT a
 *  restart: each consumer reads the setting at use time (per segment close,
 *  per request, per spawn). .env values only seed defaults on a fresh volume. */
interface KeyInfo { from: "settings" | "env" | null; hint: string | null }

/** Never surface a key hint verbatim — keep the configured-state readable
 *  but show only a masked tail ("settings***4f2a"). */
function maskHint(hint: string | null | undefined): string {
  if (!hint) return "";
  const clean = hint.replace(/[\u2026.]+$/g, "").trim();
  if (!clean) return "";
  const tail = clean.slice(-4);
  return `***${tail}`;
}
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

interface ModelQuota {
  model: string;
  available: boolean;
  exhausted: boolean;
  exhaustedUntil: number | null;
  exhaustedReason: string | null;
  rpmLimit: number | null;
  rpdLimit: number | null;
  last429: string | null;
  lastUsedAt: string | null;
}

const FIELDS: {
  key: keyof AllSettings; label: string; unit: string; tag: string; tagTone?: string;
  desc: string; min: number; max: number;
}[] = [
  { key: "recordRetentionDays", label: "Retention Policy", unit: "DAYS", tag: "0 = forever",
    desc: "Keep raw video archives", min: 0, max: 3650 },
  { key: "batchSegments", label: "Live Batch Size", unit: "SEGMENTS", tag: "PER_REQ", tagTone: "settings-stepper-tag--cyan",
    desc: "Live segments per batch", min: 1, max: 6 },
  { key: "transcribeBatch", label: "Manual Batch Size", unit: "CHUNKS", tag: "RE-PROCESS",
    desc: "Audio chunks for course repass", min: 1, max: 9 },
  { key: "joinEarlyMinutes", label: "Early Join Lead", unit: "MINUTES", tag: "CRON_LEAD",
    desc: "Pre-flight connection buffer", min: 0, max: 30 },
];

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "Just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function untilTime(ms: number | null): string {
  if (!ms) return "?";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

export default function SettingsScreen() {
  const [s, setS] = useState<AllSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // key drafts: empty = leave as-is; typed = override; cleared flag = remove override
  const [keyDrafts, setKeyDrafts] = useState<{ gemini: string; glm: string; glmBase: string }>({ gemini: "", glm: "", glmBase: "" });
  const [keyDirty, setKeyDirty] = useState<{ gemini: boolean; glm: boolean; glmBase: boolean }>({ gemini: false, glm: false, glmBase: false });
  const [quotas, setQuotas] = useState<ModelQuota[] | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((v: AllSettings) => {
        setS(v);
        setKeyDrafts({ gemini: "", glm: "", glmBase: v.keys?.glmBase ?? "" });
      })
      .catch(() => setS({ ...({} as AllSettings), offline: true, transcribe: true,
        recordRetentionDays: 30, batchSegments: 4, transcribeBatch: 9,
        geminiModels: "", joinEarlyMinutes: 3 }));
  }, []);

  useEffect(() => {
    const load = () =>
      fetch("/api/models")
        .then((r) => r.json())
        .then(setQuotas)
        .catch(() => setQuotas([]));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const chain = useMemo(
    () => (s?.geminiModels ?? "").split(",").map((m) => m.trim()).filter(Boolean),
    [s?.geminiModels],
  );
  const quotaMap = useMemo(() => new Map((quotas ?? []).map((q) => [q.model, q])), [quotas]);
  /** the daemon dispatches the first chain model that is available & not cooling down */
  const activeModel = useMemo(() => {
    const usable = chain.find((m) => {
      const q = quotaMap.get(m);
      return !q || (q.available && !q.exhausted);
    });
    return usable ?? chain[0] ?? null;
  }, [chain, quotaMap]);
  const cooling = (quotas ?? []).filter((q) => !q.available || q.exhausted).length;
  const allHealthy = (quotas ?? []).length > 0 && cooling === 0;

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

  /** swap chain[i] with its neighbour — rewrites geminiModels */
  const move = (i: number, dir: -1 | 1) => {
    if (!s) return;
    const j = i + dir;
    if (j < 0 || j >= chain.length) return;
    const next = [...chain];
    [next[i], next[j]] = [next[j], next[i]];
    setS({ ...s, geminiModels: next.join(",") });
    setDirty(true);
  };

  if (!s) {
    return (
      <Panel title="Settings" subtitle="loading…" />
    );
  }

  const offline = !!s.offline;

  return (
    <div className="settings-screen">
      {/* ── Hero ── */}
      <div className="settings-hero">
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Eyebrow tone="emerald">
              <LiveDot />
              PIPELINE CONTROL MATRIX
            </Eyebrow>
            <span className="settings-hero-version">/ v2.4</span>
          </span>
          <h1>Settings &amp; Automation Engine</h1>
          <p className="settings-hero-sub">
            Configure real-time audio transcription sequences, dynamic quota failover chains, API
            credentials, and autonomous cron recording lifecycles.
          </p>
        </div>
        <div className="settings-hero-trio">
          <div className="settings-hero-stat">
            <span className="settings-hero-stat-label">Active Fallback</span>
            <span className="settings-hero-stat-value settings-hero-stat-value--emerald">
              {chain.length} Tiered
            </span>
          </div>
          <span className="settings-hero-divider" />
          <div className="settings-hero-stat">
            <span className="settings-hero-stat-label">Current Daemon</span>
            <span className="settings-hero-stat-value settings-hero-stat-value--emerald" title={activeModel ?? undefined}>
              {offline ? "offline" : activeModel ?? "—"}
            </span>
          </div>
          <span className="settings-hero-divider" />
          <div className="settings-hero-stat">
            <span className="settings-hero-stat-label">Failover Policy</span>
            <span className="settings-hero-stat-value settings-hero-stat-value--cyan">Eager Backoff</span>
          </div>
        </div>
      </div>

      {/* ── Config row: processing + vault ── */}
      <div className="settings-config-grid">
        {/* Card 1: Transcription & Processing */}
        <Panel
          icon={<MicrophoneIcon className="heroicon" />}
          title="Transcription &amp; Processing"
          actions={<span className="settings-hero-version">ENGINE_CONFIG</span>}
          className="settings-col"
        >
          {/* master switch */}
          <div className="settings-toggle-card">
            <div>
              <p className="settings-toggle-title">Transcribe &amp; Summarize (Gemini)</p>
              <p className="settings-toggle-desc">
                {offline
                  ? "backend offline — change may not have saved"
                  : s.transcribe
                    ? "When triggered, audio segments are transcribed and synopsized as classrooms conclude. Auto-fails over on HTTP 429 quota exhaustion."
                    : "OFF — recordings only (mp4 kept, no API usage)."}
              </p>
            </div>
            <Toggle checked={s.transcribe} onChange={toggle} title="Toggle transcription pipeline" />
          </div>

          {/* numeric parameters */}
          <div className="settings-stepper-grid">
            {FIELDS.map((f) => (
              <div key={f.key} className="settings-stepper-card">
                <div className="settings-stepper-head">
                  <span className="vault-label">{f.label}</span>
                  <span className={`settings-stepper-tag ${f.tagTone ?? ""}`.trim()}>{f.tag}</span>
                </div>
                <Stepper
                  unit={f.unit}
                  description={f.desc}
                  value={s[f.key] as number}
                  min={f.min}
                  max={f.max}
                  onChange={(n) => { setS({ ...s, [f.key]: n }); setDirty(true); }}
                />
              </div>
            ))}
          </div>

          {/* dynamic failover sequence */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span className="vault-label" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                Dynamic Failover Sequence
                <QuestionMarkCircleIcon className="heroicon" style={{ display: "inline", width: 14, height: 14, color: "var(--outline)" }} />
              </span>
              <span className="failover-hint">Shift priority with the arrows</span>
            </div>
            <div className="failover-pills">
              {chain.length === 0 && <span className="muted">No models configured</span>}
              {chain.map((m, i) => {
                const q = quotaMap.get(m);
                const active = !offline && m === activeModel;
                return (
                  <span key={`${m}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {i > 0 && <ArrowRightIcon className="failover-arrow" />}
                    <span className={`failover-pill ${active ? "failover-pill--active" : "failover-pill--muted"}`}>
                      <span className="failover-pill-idx">{i + 1}.</span>
                      {m}
                      {active && <BoltIcon className="heroicon" style={{ display: "inline", width: 12, height: 12 }} />}
                      {q && !q.available && <span title="hard-failed (404/403) — dropped from the chain">✕</span>}
                    </span>
                    <span className="failover-reorder">
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`move ${m} up`} title="raise priority">
                        <ChevronUpIcon className="heroicon" style={{ display: "inline", width: 12, height: 12 }} />
                      </button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === chain.length - 1} aria-label={`move ${m} down`} title="lower priority">
                        <ChevronDownIcon className="heroicon" style={{ display: "inline", width: 12, height: 12 }} />
                      </button>
                    </span>
                  </span>
                );
              })}
            </div>
            <div className="failover-raw">
              <textarea
                id="geminiModels"
                rows={2}
                value={s.geminiModels}
                onChange={(e) => { setS({ ...s, geminiModels: e.target.value }); setDirty(true); }}
                title="comma-separated model ids, tried in order until one isn't rate-limited"
              />
              <span className="failover-raw-tag">RAW_LIST</span>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: "0.75rem" }}>
              comma-separated, tried in order until one isn&apos;t rate-limited — table below shows live quota state
            </p>
          </div>
        </Panel>

        {/* Card 2: API Credentials & Vault */}
        <Panel
          icon={<KeyIcon className="heroicon" />}
          title="API Credentials &amp; Vault"
          actions={<span className="settings-hero-version">PERSISTENT_VOL</span>}
          className="settings-col"
        >
          <p className="vault-desc">
            Secrets are stored on the local cluster data volume and applied without a container
            restart. A value typed here overrides the environment; the &ldquo;use env&rdquo; button
            removes the override. Keys are never revealed in plaintext.
          </p>

          {([
            { id: "gemini" as const, label: "Gemini API Key", icon: <LockClosedIcon className="vault-well-icon" />, type: "password" as const, ph: "AIza…" },
            { id: "glm" as const, label: "GLM API Key", icon: <LockClosedIcon className="vault-well-icon" />, type: "password" as const, ph: "Zhipu coding-plan key…" },
          ]).map((f) => {
            const info = s.keys?.[f.id];
            return (
              <div key={f.id} className="vault-row">
                <div className="vault-row-head">
                  <label htmlFor={`key-${f.id}`} className="vault-label">{f.label}</label>
                  {info?.from && (
                    <span className={`vault-status ${info.from === "settings" ? "vault-status--set" : ""}`}>
                      <LiveDot static />
                      set: {info.from}{maskHint(info.hint)}
                    </span>
                  )}
                </div>
                <div className="vault-well">
                  {f.icon}
                  <input
                    id={`key-${f.id}`}
                    className={f.type === "password" ? "password" : ""}
                    type={f.type}
                    autoComplete="off"
                    placeholder={info?.from ? `from ${info.from} (${info.hint ?? ""}) — type to override` : f.ph}
                    value={keyDrafts[f.id]}
                    onChange={(e) => {
                      setKeyDrafts((m) => ({ ...m, [f.id]: e.target.value }));
                      setKeyDirty((m) => ({ ...m, [f.id]: true }));
                      setDirty(true);
                    }}
                  />
                  <MicroButton disabled={busy || !keyDirty[f.id]} onClick={save} title="store this override on the data volume (applies immediately)">
                    Set
                  </MicroButton>
                  <MicroButton
                    disabled={busy}
                    title="remove the stored key and fall back to the environment"
                    onClick={async () => {
                      setBusy(true);
                      const v = await put({ [`${f.id}ApiKey`]: "" });
                      if (v) {
                        setS(v);
                        setKeyDrafts((m) => ({ ...m, [f.id]: "" }));
                        setKeyDirty((m) => ({ ...m, [f.id]: false }));
                        setMsg("cleared — using env key");
                      }
                      setBusy(false);
                    }}
                  >
                    use env
                  </MicroButton>
                </div>
              </div>
            );
          })}

          {/* GLM base URL — plain endpoint override, no ping endpoint exists */}
          <div className="vault-row">
            <div className="vault-row-head">
              <label htmlFor="key-glmBase" className="vault-label">GLM Base URL Endpoint</label>
              <span className="settings-stepper-tag">PROXY_TARGET</span>
            </div>
            <div className="vault-well">
              <LinkIcon className="vault-well-icon" />
              <input
                id="key-glmBase"
                type="text"
                autoComplete="off"
                placeholder="https://open.bigmodel.cn/api/coding/paas/v4"
                value={keyDirty.glmBase ? keyDrafts.glmBase : (s.keys?.glmBase ?? "")}
                onChange={(e) => {
                  setKeyDrafts((m) => ({ ...m, glmBase: e.target.value }));
                  setKeyDirty((m) => ({ ...m, glmBase: true }));
                  setDirty(true);
                }}
              />
              <MicroButton
                disabled={busy || (!keyDirty.glmBase && !s.keys?.glmBase)}
                title="remove the stored override and use the default/env base URL"
                onClick={async () => {
                  setBusy(true);
                  const v = await put({ glmBase: "" });
                  if (v) {
                    setS(v);
                    setKeyDrafts((m) => ({ ...m, glmBase: "" }));
                    setKeyDirty((m) => ({ ...m, glmBase: false }));
                    setMsg("cleared — using default/env base URL");
                  }
                  setBusy(false);
                }}
              >
                use default
              </MicroButton>
            </div>
          </div>
        </Panel>
      </div>

      {/* ── Model Fallback Chain & Quota Monitor ── */}
      <Panel
        icon={<CircleStackIcon className="heroicon" />}
        title="Model Fallback Chain &amp; Quota Monitor"
        actions={
          <span className={`quota-health ${allHealthy ? "quota-health--ok" : "quota-health--warn"}`}>
            <LiveDot static tone={allHealthy ? "emerald" : "red"} />
            {allHealthy ? "All Healthy" : `${cooling} cooling down`}
          </span>
        }
        subtitle="Tried top to bottom. On a 429 the real limit is learned from the response, the model cools down (retry-after for RPM, midnight PT for daily) and the next model is used."
      >
        {!quotas ? (
          <p className="muted">Loading model quotas…</p>
        ) : quotas.length === 0 ? (
          <p className="muted">No models configured — set the chain above or GEMINI_MODELS in .env</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model Identifier</th>
                  <th>Engine Status</th>
                  <th>RPM Threshold</th>
                  <th>Daily RPD Limit</th>
                  <th>Last Dispatched</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {quotas.map((q) => {
                  const idx = chain.indexOf(q.model);
                  const isPrimary = !offline && q.model === activeModel;
                  return (
                    <tr key={q.model}>
                      <td>
                        <span className="quota-model">
                          {q.model}
                          {isPrimary && <Badge variant="emerald">PRIMARY</Badge>}
                        </span>
                      </td>
                      <td>
                        {!q.available ? (
                          <span className="badge badge-amber">Unavailable (404)</span>
                        ) : q.exhausted ? (
                          <Badge variant="red">
                            {q.exhaustedReason === "rpd" ? "Daily quota" : "Rate limit"} → until {untilTime(q.exhaustedUntil)}
                          </Badge>
                        ) : (
                          <Badge variant="emerald">
                            <LiveDot static />
                            Available
                          </Badge>
                        )}
                      </td>
                      <td className="quota-mono quota-mono--on">{q.rpmLimit ?? "—"}</td>
                      <td className="quota-mono quota-mono--on">{q.rpdLimit ?? "—"}</td>
                      <td className="quota-mono quota-mono--on">{relTime(q.lastUsedAt)}{isPrimary && !offline ? " (Active)" : ""}</td>
                      <td>
                        <span className="quota-actions">
                          <button type="button" onClick={() => move(idx, -1)} disabled={idx <= 0} aria-label={`raise ${q.model} priority`} title="raise priority">
                            <ChevronUpIcon className="heroicon" style={{ display: "inline", width: 14, height: 14 }} />
                          </button>
                          <button type="button" onClick={() => move(idx, 1)} disabled={idx < 0 || idx >= chain.length - 1} aria-label={`lower ${q.model} priority`} title="lower priority">
                            <ChevronDownIcon className="heroicon" style={{ display: "inline", width: 14, height: 14 }} />
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="callout">
          <InformationCircleIcon className="heroicon" style={{ display: "inline", width: 16, height: 16, color: "var(--outline)", flex: "none", marginTop: 2 }} />
          <span>
            Quota limits show <code>—</code> until an initial <code>HTTP 429 Too Many Requests</code>{" "}
            response payload reveals the upstream quota tier. Gemini does not expose proactive quota
            headers on successful requests. Backoff initiates instantly to the subsequent tier,
            auto-cooling until midnight Pacific Time for daily limits.
          </span>
        </div>
      </Panel>

      {/* ── Sticky action bar ── */}
      <div className="settings-actionbar">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-md)", flexWrap: "wrap", minWidth: 0 }}>
          <span className={`settings-actionbar-state ${dirty ? "settings-actionbar-state--dirty" : ""}`}>
            <LiveDot static={dirty ? false : true} />
            Config state: {dirty ? "Unsaved modifications in staging" : "Synchronized — no pending changes"}
          </span>
          {msg && <span className="settings-actionbar-msg">{msg}</span>}
        </div>
        <div className="settings-actionbar-buttons">
          <button
            className="btn btn-destructive"
            onClick={purgeSegments}
            disabled={busy}
            title="TEST: remove all raw webm/ogg segments (mp4s stay)"
          >
            <TrashIcon className="heroicon" style={{ display: "inline" }} />
            Purge Raw Segments
          </button>
          <PrimaryButton onClick={save} disabled={busy || !dirty} icon={<span style={{ fontSize: "0.85em" }}>💾</span>}>
            Save Changes
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
