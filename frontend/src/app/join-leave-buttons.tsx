"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MicroButton, PrimaryButton } from "@/components/ui";

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
        compact ? (
          <MicroButton className="btn-primary" onClick={() => act("join")} disabled={busy !== null} title={`Join + record "${title}" now`}>
            {busy === "join" ? "joining…" : "Join"}
          </MicroButton>
        ) : (
          <PrimaryButton onClick={() => act("join")} disabled={busy !== null} title={`Join + record "${title}" now`}>
            {busy === "join" ? "joining…" : "Join now"}
          </PrimaryButton>
        )
      )}
      {joined && (
        <MicroButton className="btn-destructive" onClick={() => act("leave")} disabled={busy !== null} title="Stop recording, consolidate, and leave">
          {busy === "leave" ? "leaving…" : compact ? "Leave" : "Leave meeting"}
        </MicroButton>
      )}
      {msg && <span className="muted" style={{ fontSize: "0.6875rem" }}>{msg.slice(0, 60)}</span>}
    </span>
  );
}
