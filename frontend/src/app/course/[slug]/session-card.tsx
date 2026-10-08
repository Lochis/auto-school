"use client";

import { useState } from "react";
import Link from "next/link";
import { t12 } from "@/lib/format";
import { useRouter } from "next/navigation";
import type { Session } from "@/lib/data";
import {
  ArrowPathIcon,
  ArrowUpRightIcon,
  LinkIcon,
  PlayCircleIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import "../../sessions-ui.css";

/** Session row: date link + pipeline status chips, then the utility command
 *  bar (Re-transcribe / move-to-course / Delete / Play recording). The mp4
 *  has a video track, so it renders in a <video> element (an <audio> tag
 *  shows only the soundtrack) mounted on demand — 20+ concurrent <video>
 *  elements crash the page. */
export default function SessionCard({ session, course, courses = [] }: { session: Session; course: string; courses?: string[] }) {
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false); // player mounts on demand
  const [moveTo, setMoveTo] = useState("");
  const [moveMsg, setMoveMsg] = useState("");
  const router = useRouter();

  const move = async () => {
    if (!moveTo || moveTo === course) return;
    setBusy(true); setMoveMsg("");
    try {
      const r = await fetch("/api/session/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: course, to: moveTo, stem: session.stem }),
      });
      const j = (await r.json().catch(() => ({}))) as { moved?: number; error?: string };
      if (!r.ok) setMoveMsg(j.error ?? `HTTP ${r.status}`);
      else { setMoveMsg(""); router.refresh(); }
    } catch { setMoveMsg("move failed — backend unreachable"); }
    finally {
      setBusy(false);
    }
  };

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

  const hasText = Boolean(session.transcript || session.timeline);

  return (
    <div>
      <div className="sess-card-head">
        <Link className="sess-card-date" href={`/course/${course}/session/${session.stem}`}>
          {session.date}{session.time ? ` · ${t12(session.time)}` : ""} <ArrowUpRightIcon className="heroicon" />
        </Link>
        <div className="sess-status">
          <span className={`sess-dot ${session.audio ? "" : "sess-dot--off"}`} />
          <span>{session.audio ? "recorded" : "no recording"}</span>
          {hasText && (
            <>
              <span>·</span>
              <span>transcribed</span>
            </>
          )}
          {session.segmentCount ? (
            <>
              <span>·</span>
              <span className="code-chip sess-seg-chip">{session.segmentCount} segment{session.segmentCount === 1 ? "" : "s"} merged</span>
            </>
          ) : null}
        </div>
        {session.joinUrl && (
          <a className="sess-meeting" href={session.joinUrl} target="_blank" rel="noreferrer" title="Open this meeting in Teams">
            <LinkIcon className="heroicon" /> meeting
          </a>
        )}
      </div>

      <div className="sess-actions">
        {session.audio && (
          <button className="btn" onClick={transcribe} disabled={busy} title="Run the Gemini model chain over this recording — transcript + notes">
            <ArrowPathIcon className="heroicon" /> {busy ? "…" : hasText ? "Re-transcribe" : "Transcribe"}
          </button>
        )}
        {courses.length > 1 && (
          <span className="sess-move-wrap">
            <select className="sess-move" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} disabled={busy} title="Refile this session to another course">
              <option value="">move to…</option>
              {courses.filter((c) => c !== course).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {moveTo && <button className="btn btn-micro" onClick={move} disabled={busy}>{busy ? "moving…" : "Move →"}</button>}
          </span>
        )}
        <button className="btn btn-destructive" onClick={purge} disabled={busy} title="Delete the recording and its transcript/notes/timeline">
          <TrashIcon className="heroicon" /> {busy ? "deleting…" : "Delete"}
        </button>
        {session.audio && !broken && !open && (
          <button className="btn btn-primary" onClick={() => setOpen(true)}>
            <PlayCircleIcon className="heroicon" /> Play recording
          </button>
        )}
      </div>

      {moveMsg && <p className="sess-msg sess-msg--err">{moveMsg}</p>}
      {job && <p className="sess-msg">{job}</p>}
      {session.audio && !broken && open && (
        <div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            controls
            autoPlay
            preload="metadata"
            src={`/api/media/${session.audio}`}
            onError={() => setBroken(true)}
          />
          <div className="sess-close-row">
            <button className="btn btn-micro" onClick={() => setOpen(false)}><XMarkIcon className="heroicon" /> close player</button>
          </div>
        </div>
      )}
      {session.audio && broken && (
        <p className="sess-msg">
          recording unplayable (corrupt consolidation) — transcription still works; delete when done with it
        </p>
      )}
    </div>
  );
}
