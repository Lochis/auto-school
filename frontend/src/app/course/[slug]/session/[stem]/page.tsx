import Link from "next/link";
import { notFound } from "next/navigation";
import { readFileSync } from "node:fs";
import { DATA_DIR, sessions } from "@/lib/data";
import LazyNotes from "../../lazy-notes";
import AudioPlayer from "@/components/sessions/audio-player";
import TranscriptTimeline, { type TimelineEntry } from "./transcript-timeline";
import { CodeChip, Eyebrow } from "@/components/ui";
import { t12 } from "@/lib/format";
import "../../../../sessions-ui.css";

export const dynamic = "force-dynamic";

/** Session detail: full notes + the seekable transcript timeline (the
 *  reference view — click a topic, the audio jumps there). */
export default async function SessionPage({ params }: { params: Promise<{ slug: string; stem: string }> }) {
  const { slug, stem } = await params;
  const s = sessions(slug).find((x) => x.stem === stem);
  if (!s) notFound();

  let entries: TimelineEntry[] = [];
  if (s.timeline) {
    try {
      entries = JSON.parse(readFileSync(`${DATA_DIR}/${s.timeline}`, "utf8"));
    } catch {
      entries = [];
    }
  }

  const courseName = slug.replace(/_/g, " ");
  const meetingTitle = stem.split("__")[1]?.replace(/_/g, " ").trim();
  const timeLabel = s.time ? ` · ${t12(s.time)}` : "";

  return (
    <main>
      <div className="sess-page">
        <div className="breadcrumb">
          <div className="breadcrumb-trail">
            <Link href={`/course/${slug}`}>← {courseName}</Link>
            <span className="breadcrumb-sep">/</span>
            <CodeChip>{s.date}</CodeChip>
          </div>
          <Eyebrow>Session Recording</Eyebrow>
        </div>

        <div>
          <h1 style={{ margin: 0 }}>{meetingTitle ?? `${s.date}${timeLabel}`}</h1>
          <p className="muted sess-detail-meta">
            {courseName} · {s.date}{timeLabel} · {entries.length} transcribed segment{entries.length === 1 ? "" : "s"}
            {s.audio ? "" : " · no recording"}
          </p>
        </div>

        {s.audio && <AudioPlayer course={slug} session={{ ...s, audio: s.audio }} />}

        <section className="panel">
          <header style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <h2 className="panel-title">Timeline</h2>
            <span className="muted">click a topic to jump the playhead</span>
          </header>
          <div style={{ height: 12 }} />
          {entries.length > 0 && s.audio ? (
            <TranscriptTimeline src={`/api/media/${s.audio}`} entries={entries} />
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {s.audio ? "no transcript for this session — run “Transcribe” from the course page" : "no recording"}
            </p>
          )}
        </section>

        {s.notes && (
          <section className="panel">
            <LazyNotes course={slug} stem={stem} kind="notes" eager segments={s.segmentCount} />
          </section>
        )}
      </div>
    </main>
  );
}
