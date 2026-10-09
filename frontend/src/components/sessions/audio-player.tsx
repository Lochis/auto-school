"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Session } from "@/lib/data";
import { t12 } from "@/lib/format";
import { CodeChip } from "@/components/ui";
import { PauseIcon, PlayIcon, SpeakerWaveIcon, SpeakerXMarkIcon } from "@heroicons/react/24/outline";
import "../../app/sessions-ui.css";

const SPEEDS = [1, 1.25, 1.5, 2] as const;

const fmt = (s: number): string => {
  if (!isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** Inline audio-player HUD (screen 2 "Active Audio Player Dock"): emerald
 *  play tile, seekable progress bar with round scrubber, elapsed/total,
 *  playback-speed pill (1x → 1.25x → 1.5x → 2x), mute. The mp4 carries a
 *  video track, so playback runs through a hidden <video> element (an
 *  <audio> tag would only surface the soundtrack) — the full video player
 *  stays available on the session detail page. */
export default function AudioPlayer({ course, session }: {
  course: string;
  session: Session & { audio: string };
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rateIdx, setRateIdx] = useState(0);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const on = (ev: string, fn: () => void) => {
      v.addEventListener(ev, fn);
      return () => v.removeEventListener(ev, fn);
    };
    const offs = [
      on("play", () => setPlaying(true)),
      on("pause", () => setPlaying(false)),
      on("ended", () => setPlaying(false)),
      on("timeupdate", () => setT(v.currentTime)),
      on("loadedmetadata", () => setDur(v.duration)),
      on("durationchange", () => setDur(v.duration)),
      on("error", () => setBroken(true)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const toggle = (): void => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const seekAt = (ratio: number): void => {
    const v = ref.current;
    if (!v || !dur || !isFinite(dur)) return;
    v.currentTime = Math.max(0, Math.min(1, ratio)) * dur;
  };

  const cycleRate = (): void => {
    const i = (rateIdx + 1) % SPEEDS.length;
    setRateIdx(i);
    const v = ref.current;
    if (v) v.playbackRate = SPEEDS[i];
  };

  const toggleMute = (): void => {
    const v = ref.current;
    const m = !muted;
    setMuted(m);
    if (v) v.muted = m;
  };

  const title = session.stem.split("__")[1]?.replace(/_/g, " ").trim() || "Session recording";
  const meta = [
    session.time ? t12(session.time) : null,
    session.segmentCount ? `${session.segmentCount} segments` : null,
    session.audio.split(".").pop()?.toUpperCase() ?? null,
  ].filter(Boolean).join(" · ");
  const pct = dur > 0 ? (t / dur) * 100 : 0;

  return (
    <section className="sess-player" aria-label="Latest recording">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={ref} src={`/api/media/${session.audio}`} preload="metadata" style={{ display: "none" }} />
      <div className="sess-player-left">
        <button className="sess-play-btn" onClick={toggle} disabled={broken} title={playing ? "Pause" : "Play"}>
          {playing ? <PauseIcon className="heroicon" /> : <PlayIcon className="heroicon" />}
        </button>
        <div className="sess-player-info">
          <div className="sess-player-title-row">
            <Link className="sess-player-title" href={`/course/${course}/session/${session.stem}`}>{title}</Link>
            <CodeChip>{session.date}</CodeChip>
          </div>
          <span className="sess-player-meta">
            {broken ? "recording unplayable — transcript access still works" : meta || "recording on file"}
          </span>
        </div>
      </div>
      <div
        className="sess-player-scrub"
        title="Seek"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seekAt((e.clientX - r.left) / r.width);
        }}
      >
        <span className="sess-time">{fmt(t)}</span>
        <div className="progress-bar" aria-hidden="true">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
          {pct > 0 && pct < 100 && <span className="progress-bar-scrubber" style={{ left: `${pct}%` }} />}
        </div>
        <span className="sess-time">{fmt(dur)}</span>
      </div>
      <div className="sess-player-right">
        <button className="sess-speed" onClick={cycleRate} title="Playback speed">{SPEEDS[rateIdx]}x</button>
        <button className="sess-square-btn" onClick={toggleMute} title={muted ? "Unmute" : "Mute"}>
          {muted ? <SpeakerXMarkIcon className="heroicon" /> : <SpeakerWaveIcon className="heroicon" />}
        </button>
      </div>
    </section>
  );
}
