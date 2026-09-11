import Link from "next/link";
import { notFound } from "next/navigation";
import { readFileSync } from "node:fs";
import { DATA_DIR, sessions } from "@/lib/data";
import LazyNotes from "../../lazy-notes";
import { t12 } from "@/lib/format";
import TranscriptTimeline, { type TimelineEntry } from "./transcript-timeline";

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

  return (
    <main>
      <p><Link href={`/course/${slug}`}>← {slug.replace(/_/g, " ")}</Link></p>
      <h1 style={{ marginBottom: 0 }}>{s.date}{s.time ? ` · ${t12(s.time)}` : ""}</h1>
      <p className="muted">{slug.replace(/_/g, " ")} — {entries.length} transcribed segment{entries.length === 1 ? "" : "s"}</p>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Timeline</h2>
        {entries.length > 0 && s.audio ? (
          <TranscriptTimeline src={`/api/media/${s.audio}`} entries={entries} />
        ) : (
          <p className="muted">
            {s.audio ? "no transcript for this session — run ✎ Transcribe from the course page" : "no recording"}
          </p>
        )}
      </div>

      {s.notes && (
        <div className="card">
          <LazyNotes course={slug} stem={stem} kind="notes" eager />
        </div>
      )}
    </main>
  );
}
