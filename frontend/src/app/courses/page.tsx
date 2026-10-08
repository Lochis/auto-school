import { courses, sessions, semesterStartOf, weekOf } from "@/lib/data";
import { candidateTitles, folders, readMapping } from "@/lib/mapping";
import { readDeadlines } from "@/lib/deadlines";
import CoursesScreen from "@/components/courses/courses-screen";

export const dynamic = "force-dynamic"; // data changes as the backend records

export default function CoursesPage() {
  // serialize server-side (node:fs lib is not client-safe)
  const courseList = courses().map((slug) => {
    const start = semesterStartOf(slug);
    return {
      slug,
      start,
      sessions: sessions(slug).map((s) => ({
        stem: s.stem,
        date: s.date,
        time: s.time ?? null,
        week: start ? weekOf(s.date, start) : null,
        audio: !!s.audio,
        notes: !!s.notes,
        transcript: !!s.transcript || s.hasTimeline,
      })),
    };
  });
  const mapping = readMapping();
  const mappingSnap = { mapping, folders: folders(), candidates: candidateTitles(mapping) };

  return (
    <main>
      <CoursesScreen deadlines={readDeadlines()} courseList={courseList} mappingSnap={mappingSnap} />
    </main>
  );
}
