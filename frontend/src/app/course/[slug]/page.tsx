import Link from "next/link";
import { notFound } from "next/navigation";
import { courses, readText, sessions, timelineToMd } from "@/lib/data";
import SessionCard from "./session-card";
import SessionNotes from "./session-notes";

export const dynamic = "force-dynamic";

export default async function CoursePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!courses().includes(slug)) notFound();
  const list = sessions(slug);
  return (
    <main>
      <p><Link href="/">← All courses</Link></p>
      <h1>{slug.replace(/_/g, " ")}</h1>
      <p className="muted">{list.length} session{list === null || list.length === 1 ? "" : "s"}, newest first.</p>
      {list.map((s) => {
        // manual job writes transcript.md; the live pipeline keeps transcripts
        // in timeline.json — either way they render in the collapsible below
        const transcriptMd = s.transcript
          ? readText(s.transcript)
          : timelineToMd(s.timeline);
        return (
          <div className="card" key={s.stem}>
            <SessionCard session={{ ...s, transcript: transcriptMd ? (s.transcript ?? "timeline") : undefined }} course={slug} />
            {s.notes && <SessionNotes markdown={readText(s.notes) ?? "*(notes unreadable)*"} />}
            {transcriptMd && (
              <details>
                <summary>Transcript</summary>
                <SessionNotes markdown={transcriptMd} />
              </details>
            )}
          </div>
        );
      })}
    </main>
  );
}
