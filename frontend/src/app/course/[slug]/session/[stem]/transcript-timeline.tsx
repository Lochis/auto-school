"use client";

import { useEffect, useRef, useState } from "react";

export interface TimelineEntry {
  meeting: string;
  offsetSec: number;
  transcript: string;
  visualNotes: { t: string; note: string }[];
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Transcript timeline synced to the player: click a topic → audio seeks
 *  (#t= fragments also work when linking from elsewhere). Visual notes from
 *  the Gemini batches sit under each entry. */
export default function TranscriptTimeline({ src, entries }: { src: string; entries: TimelineEntry[] }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setT(a.currentTime);
    a.addEventListener("timeupdate", onTime);
    return () => a.removeEventListener("timeupdate", onTime);
  }, []);

  const seek = (s: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = s;
    a.play().catch(() => {});
  };

  // highlight the entry covering the current playhead
  const activeIdx = entries.findIndex((e, i) =>
    t >= e.offsetSec && (i === entries.length - 1 || t < entries[i + 1].offsetSec));

  const shown = filter
    ? entries.map((e, i) => ({ e, i })).filter(({ e }) =>
        (e.transcript + " " + e.visualNotes.map((v) => v.note).join(" ")).toLowerCase().includes(filter.toLowerCase()))
    : entries.map((e, i) => ({ e, i }));

  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src={src} controls preload="metadata" style={{ width: "100%" }} />
      <p className="muted" style={{ margin: "8px 0" }}>
        {entries.length} segment{entries.length === 1 ? "" : "s"} · playing {fmt(t)}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="search transcript & notes…"
          style={{ marginLeft: 12, padding: "3px 8px", background: "var(--bg, #141414)", border: "1px solid #333", borderRadius: 6, color: "inherit" }}
        />
      </p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {shown.map(({ e, i }) => (
          <li
            key={i}
            onClick={() => seek(e.offsetSec)}
            style={{
              padding: "8px 10px",
              margin: "4px 0",
              borderRadius: 8,
              cursor: "pointer",
              background: i === activeIdx && !filter ? "rgba(125,220,154,0.08)" : "transparent",
              borderLeft: `3px solid ${i === activeIdx && !filter ? "#7ddc9a" : "transparent"}`,
            }}
          >
            <code style={{ background: "none", padding: 0, color: "#7ddc9a" }}>{fmt(e.offsetSec)}</code>{" "}
            <span style={{ opacity: t >= e.offsetSec ? 1 : 0.8 }}>{e.transcript}</span>
            {e.visualNotes.length > 0 && (
              <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0 14px" }}>
                {e.visualNotes.map((v, j) => (
                  <li key={j} className="muted" style={{ fontSize: 13, margin: "2px 0" }}>
                    <code style={{ background: "none", padding: 0 }}>{v.t}</code> 👁 {v.note}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {shown.length === 0 && <li className="muted">no matching transcript</li>}
      </ul>
    </div>
  );
}
