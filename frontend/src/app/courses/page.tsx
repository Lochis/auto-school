import { listCourses, listSessions, semesterStartOf, weekOf, courseIconOf, deadlinesList, mappingSnap } from "@/lib/backend";
import CoursesScreen from "@/components/courses/courses-screen";

export const dynamic = "force-dynamic"; // data changes as the backend records

export default async function CoursesPage() {
  // serialize server-side (node:fs lib is not client-safe)
  const courseList = await Promise.all((await listCourses()).map(async (slug) => {
    const start = await semesterStartOf(slug);
    return {
      slug,
      icon: await courseIconOf(slug),
      start,
      sessions: (await listSessions(slug)).map((s) => ({
        stem: s.stem,
        date: s.date,
        time: s.time ?? null,
        week: start ? weekOf(s.date, start) : null,
        audio: !!s.audio,
        notes: !!s.notes,
        transcript: !!s.transcript || s.hasTimeline,
      })),
    };
  }));

  return (
    <main>
      <CoursesScreen deadlines={await deadlinesList()} courseList={courseList} mappingSnap={await mappingSnap()} />
    </main>
  );
}
