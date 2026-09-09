"use client";

import { useState } from "react";
import Link from "next/link";
import { t12 } from "@/lib/format";
import { useRouter } from "next/navigation";
import type { Session } from "@/lib/data";

/** Player row + purge + manual transcribe. The mp4 has a video track, so it
 *  renders in a <video> element (an <audio> tag shows only the soundtrack). */
export default function SessionCard({ session, course }: { session: Session; course: string }) {
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false); // player mounts on demand — 20+ concurrent <video> elements crash the page
  const router = useRouter();

  const purge = async () => {
    if (!confirm(`Delete this session permanently?\n${session.date} — recording, transcript, notes and timeline.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/session?course=${encodeURIComponent(course)}&stem=${encodeURIComponent(session.stem)}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const transcribe = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/transcribe?course=${encodeURIComponent(course)}&stem=${encodeURIComponent(session.stem)}`, { method: "POST" });
      const j = await r.json();
      setJob(r.ok ? "transcribing — watch the activity feed on Home; this page updates when done" : String(j.error ?? "failed"));
      if (r.ok) setTimeout(() => router.refresh(), 15_000);
    } catch {
      setJob("backend unreachable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ minWidth: 120 }}>
          <Link href={`/course/${course}/session/${session.stem}`} style={{ color: "inherit", textDecoration: "underline dotted" }}>
            {session.date}{session.time ? ` · ${t12(session.time)}` : ""} ↗
          </Link>
        </strong>
        <span className="muted">
          {session.audio ? "recorded" : "no recording"}
          {(session.transcript || session.timeline) ? " · transcribed" : ""}
          {session.segmentCount ? ` · ${session.segmentCount} segment${session.segmentCount === 1 ? "" : "s"} merged` : ""}
        </span>
        {session.joinUrl && (
          <a href={session.joinUrl} target="_blank" rel="noreferrer"
             title="Open this meeting in Teams" style={{ color: "#2563eb", fontSize: 13 }}>
            🔗 meeting
          </a>
        )}
        <span style={{ flex: 1 }} />
        {session.audio && (
          <button onClick={transcribe} disabled={busy} title="Run the Gemini model chain over this recording — transcript + notes">
            {busy ? "…" : session.transcript || session.timeline ? "↻ Re-transcribe" : "✎ Transcribe"}
          </button>
        )}
        <button onClick={purge} disabled={busy} title="Delete the recording and its transcript/notes/timeline">
          {busy ? "deleting…" : "🗑 Delete"}
        </button>
      </div>
      {job && <p className="muted" style={{ margin: "6px 0 0" }}>{job}</p>}
      {session.audio && !broken && !open && (
        <button onClick={() => setOpen(true)} style={{ marginTop: 8 }}>
          ▶ Play recording
        </button>
      )}
      {session.audio && !broken && open && (
        <div style={{ marginTop: 8 }}>
          <video
            controls
            autoPlay
            preload="metadata"
            src={`/api/media/${session.audio}`}
            onError={() => setBroken(true)}
            style={{ width: "100%", maxHeight: 300, background: "#000", borderRadius: 8 }}
          />
          <button onClick={() => setOpen(false)} style={{ marginTop: 4 }}>✕ close player</button>
        </div>
      )}
      {session.audio && broken && (
        <p className="muted" style={{ margin: "8px 0 0" }}>
          recording unplayable (corrupt consolidation) — transcription still works; delete when done with it
        </p>
      )}
    </div>
  );
}
