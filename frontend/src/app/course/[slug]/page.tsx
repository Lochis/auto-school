import Link from "next/link";
import { notFound } from "next/navigation";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { courses, readText, sessions, timelineToMd, DATA_DIR } from "@/lib/data";
import SessionCard from "./session-card";
import SessionNotes from "./session-notes";
import MaterialsTab from "./materials-tab";
import IngestForm from "./ingest-form";
import ChatTab from "./chat-tab";
import CourseRename from "../../course-rename";
export const dynamic = "force-dynamic";

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
  const showAsk = tab === "ask";

  const start = semesterStart(slug);
  const groups = new Map<number, typeof list>();
  for (const s of list) {
    const w = start ? weekOf(s.date, start) : 1;
    const arr = groups.get(w) ?? [];
    arr.push(s);
    groups.set(w, arr);
  }
  const weeks = [...groups.keys()].sort((a, b) => b - a);

  const tabBtn = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      style={{ padding: "6px 14px", borderRadius: 6, fontWeight: 600, textDecoration: "none", color: active ? "#fff" : "#374151", background: active ? "#2563eb" : "#e5e7eb", fontSize: 13 }}
    >{label}</Link>
  );

  return (
    <main>
      <p><Link href="/courses">← All courses</Link></p>
      <h1 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {slug.replace(/_/g, " ")}
        <CourseRename course={slug} />
      </h1>

      {/* tab bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {tabBtn(`/course/${slug}`, `Sessions (${list.length})`, !showMaterials && !showAsk)}
        {tabBtn(`/course/${slug}?tab=materials`, "Materials", showMaterials)}
        {tabBtn(`/course/${slug}?tab=ask`, "Ask", showAsk)}
      </div>

      {showMaterials ? (
        <MaterialsTab slug={slug} />
      ) : showAsk ? (
        <ChatTab slug={slug} />
      ) : (
        <>
          {!start && <p className="muted">Tip: set a semester start on the Materials tab to group sessions by week.</p>}
          <IngestForm slug={slug} courses={courses()} semesterStart={start} />
          {weeks.map((w) => (
            <div key={w} style={{ marginBottom: 20 }}>
              {start && <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>Week {w}</h2>}
              {(groups.get(w) ?? []).map((s) => {
                const transcriptMd = s.transcript ? readText(s.transcript) : timelineToMd(s.timeline);
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
