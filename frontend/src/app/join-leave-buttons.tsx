"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Ask the daemon to manually join+record a meeting by title (UI "Join"
 *  button), or to leave the current one. */
export default function JoinLeaveButtons({ title, joined, compact = false }: { title: string; joined?: boolean; compact?: boolean }) {
  const [busy, setBusy] = useState<"join" | "leave" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const act = async (kind: "join" | "leave") => {
    setBusy(kind); setMsg(null);
    try {
      const r = await fetch("/api/backend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "join" ? { join: title } : { leave: true }),
      });
      setMsg((await r.json()).note ?? `${kind}ing…`);
      setTimeout(() => router.refresh(), kind === "join" ? 20000 : 8000);
    } catch {
      setMsg("backend unreachable");
    }
    setBusy(null);
  };

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {!joined && (
        <button onClick={() => act("join")} disabled={busy !== null} title={`Join + record "${title}" now`}>
          {busy === "join" ? "joining…" : compact ? "Join" : "Join now"}
        </button>
      )}
      {joined && (
        <button onClick={() => act("leave")} disabled={busy !== null} title="Stop recording, consolidate, and leave">
          {busy === "leave" ? "leaving…" : compact ? "Leave" : "Leave meeting"}
        </button>
      )}
      {msg && <span className="muted">{msg.slice(0, 60)}</span>}
    </span>
  );
}
