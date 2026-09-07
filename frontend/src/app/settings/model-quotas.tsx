"use client";

import { useEffect, useState } from "react";

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

const th = { padding: 8, borderBottom: "1px solid #2a2f3a" };
const td = { padding: 8, borderBottom: "1px solid #22262f" };

function statusCell(q: ModelQuota) {
  if (!q.available)
    return { text: "Unavailable (404)", bg: "#3a2a1f", color: "#ffb36b" };
  if (q.exhausted) {
    const until = q.exhaustedUntil ? new Date(q.exhaustedUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "?";
    return {
      text: `${q.exhaustedReason === "rpd" ? "Daily quota" : "Rate limit"} → until ${until}`,
      bg: "#3d1f1f",
      color: "#ff6b6b",
    };
  }
  return { text: "Available", bg: "#1f3d1f", color: "#6bff6b" };
}

export default function ModelQuotas() {
  const [quotas, setQuotas] = useState<ModelQuota[] | null>(null);

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

  return (
    <div className="card">
      <h2 style={{ margin: "0 0 12px" }}>Model chain</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        Tried top to bottom. On a 429 the real limit is learned from the response, the model cools
        down (retry-after for RPM, midnight PT for daily) and the next model is used — all logged
        in the activity feed on the home page.
      </p>
      {!quotas ? (
        <p className="muted">Loading model quotas…</p>
      ) : quotas.length === 0 ? (
        <p className="muted">No models configured — set GEMINI_MODELS in .env</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>Model</th>
              <th style={{ ...th, textAlign: "center" }}>Status</th>
              <th style={{ ...th, textAlign: "center" }}>RPM limit</th>
              <th style={{ ...th, textAlign: "center" }}>Daily limit</th>
              <th style={{ ...th, textAlign: "center" }}>Last used</th>
            </tr>
          </thead>
          <tbody>
            {quotas.map((q) => {
              const s = statusCell(q);
              return (
                <tr key={q.model}>
                  <td style={td}>
                    <code>{q.model}</code>
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontSize: "0.85rem",
                        background: s.bg,
                        color: s.color,
                      }}
                    >
                      {s.text}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>{q.rpmLimit ?? "—"}</td>
                  <td style={{ ...td, textAlign: "center" }}>{q.rpdLimit ?? "—"}</td>
                  <td style={{ ...td, textAlign: "center" }}>
                    {q.lastUsedAt ? new Date(q.lastUsedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ marginTop: 10 }}>
        Limits show “—” until the first 429 reveals them (Gemini doesn&apos;t expose them on
        successful calls).
      </p>
    </div>
  );
}
