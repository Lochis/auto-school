import Link from "next/link";
import { notFound } from "next/navigation";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { courses, readText, sessions, timelineToMd, DATA_DIR } from "@/lib/data";
import SessionCard from "./session-card";
import SessionNotes from "./session-notes";
import MaterialsTab from "./materials-tab";
import IngestForm from "./ingest-form";
export const dynamic = "force-dynamic";

/** week math mirroring the backend (see src/pipeline/materials.ts) */
function weekMonday(dstr: string): string {
  const d = new Date(`${dstr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}
function weekOf(dstr: string, start: string): number {
  const a = Date.parse(`${weekMonday(dstr)}T00:00:00Z`), b = Date.parse(`${weekMonday(start)}T00:00:00Z`);
  return Math.max(1, Math.floor((a - b) / 604_800_000) + 1);
}
function semesterStart(slug: string): string | null {
  try {
    const cfg = JSON.parse(readFileSync(join(DATA_DIR, "courses", slug, "course.json"), "utf8"));
    return typeof cfg.semesterStart === "string" ? cfg.semesterStart : null;
  } catch { return null; }
}

export default async function CoursePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { slug } = await params;
  const { tab } = await searchParams;
  if (!courses().includes(slug)) notFound();
  const list = sessions(slug);
  const showMaterials = tab === "materials";

  // group sessions by semester week (only when a semester start is configured)
  const start = semesterStart(slug);
  const groups = new Map<number, typeof list>();
  for (const s of list) {
    const w = start ? weekOf(s.date, start) : 1;
    const arr = groups.get(w) ?? [];
    arr.push(s);
    groups.set(w, arr);
  }
  const weeks = [...groups.keys()].sort((a, b) => b - a);

  return (
    <main>
      <p><Link href="/">← All courses</Link></p>
      <h1>{slug.replace(/_/g, " ")}</h1>
      {/* tab bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Link href={`/course/${slug}`} style={{ padding: "6px 14px", borderRadius: 6, fontWeight: 600, textDecoration: "none", color: !showMaterials ? "#fff" : "#374151", background: !showMaterials ? "#2563eb" : "#e5e7eb" }}>
          Sessions ({list.length})
        </Link>
        <Link href={`/course/${slug}?tab=materials`} style={{ padding: "6px 14px", borderRadius: 6, fontWeight: 600, textDecoration: "none", color: showMaterials ? "#fff" : "#374151", background: showMaterials ? "#2563eb" : "#e5e7eb" }}>
          Materials
        </Link>
      </div>
      {showMaterials ? (
        <MaterialsTab slug={slug} />
      ) : (
        <>
          {!start && <p className="muted">Tip: set a semester start on the Materials tab to group sessions by week.</p>}
          <IngestForm slug={slug} courses={courses()} semesterStart={start} />
          {weeks.map((w) => (
            <div key={w} style={{ marginBottom: 20 }}>
              {start && <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>Week {w}</h2>}
              {(groups.get(w) ?? []).map((s) => {
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
            </div>
          ))}
        </>
      )}
    </main>
  );
}
