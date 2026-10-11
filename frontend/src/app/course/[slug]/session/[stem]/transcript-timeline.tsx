"use client";

import { useState } from "react";
import { SearchInput } from "@/components/ui";
import { useSessionSync } from "./session-sync";
import "../../../../sessions-ui.css";

export interface TimelineEntry {
  meeting: string;
  offsetSec: number;
  transcript: string;
  visualNotes: { t: string; note: string }[];
}

const fmt = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** Transcript timeline synced to the AudioPlayer at the top of the page
 *  (via session-sync): click a topic → the player seeks. Visual notes from
 *  the Gemini batches sit under each entry. */
export default function TranscriptTimeline({ entries }: { entries: TimelineEntry[] }) {
  const sync = useSessionSync();
  const [filter, setFilter] = useState("");
  const t = sync?.t ?? 0;

  // highlight the entry covering the current playhead
  const activeIdx = entries.findIndex((e, i) =>
    t >= e.offsetSec && (i === entries.length - 1 || t < entries[i + 1].offsetSec));

  const shown = filter
    ? entries.map((e, i) => ({ e, i })).filter(({ e }) =>
        (e.transcript + " " + e.visualNotes.map((v) => v.note).join(" ")).toLowerCase().includes(filter.toLowerCase()))
    : entries.map((e, i) => ({ e, i }));

  return (
    <div>
      <div className="tl-toolbar">
        <span className="sess-time">
          {entries.length} segment{entries.length === 1 ? "" : "s"}
          {sync ? <> · playing {fmt(t)}</> : null}
        </span>
        <SearchInput
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="search transcript & notes…"
          style={{ width: 220 }}
        />
      </div>
      <ul className="tl-list">
        {shown.map(({ e, i }) => (
          <li
            key={i}
            className={`tl-row ${i === activeIdx && !filter ? "tl-row--active" : ""}`}
            onClick={() => sync?.seek(e.offsetSec)}
          >
            <span className="tl-stamp">{fmt(e.offsetSec)}</span>{" "}
            <span className="tl-text">{e.transcript}</span>
            {e.visualNotes.length > 0 && (
              <ul className="tl-visual">
                {e.visualNotes.map((v, j) => (
                  <li key={j}>
                    <span className="tl-stamp tl-stamp--dim">{v.t}</span> {v.note}
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
