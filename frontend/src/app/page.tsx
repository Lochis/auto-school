import Link from "next/link";
import { courses, sessions } from "@/lib/data";
import { candidateTitles, folders, readMapping } from "@/lib/mapping";
import BackendBar from "./backend-bar";
import CalendarBoard from "./calendar-board";
import CourseDelete from "./course-delete";
import MappingManager from "./mapping-manager";

export const dynamic = "force-dynamic"; // data changes as the backend records

export default function Home() {
  const list = courses().map((c) => ({ course: c, count: sessions(c).length }));
  const mapping = readMapping();
  const mappingSnap = { mapping, folders: folders(), candidates: candidateTitles(mapping) };
  return (
    <main>
      <h1>Courses</h1>
      <BackendBar />
      <CalendarBoard />
      <MappingManager initial={mappingSnap} />
      <p className="muted">Recordings and notes, filed automatically per course.</p>
      {list.length === 0 && (
        <div className="card">Nothing yet — sessions appear here once the backend records one.</div>
      )}
      {list.map(({ course, count }) => (
        <div className="card" key={course} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Link href={`/course/${encodeURIComponent(course)}`}>
            <strong>{course.replace(/_/g, " ")}</strong>
          </Link>
          <span className="muted"> — {count} session{count === 1 ? "" : "s"}</span>
          {count === 0 && <CourseDelete course={course} />}
        </div>
      ))}
    </main>
  );
}
