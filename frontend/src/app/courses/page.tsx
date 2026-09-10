import Link from "next/link";
import { courses, sessions, semesterStartOf, weekOf } from "@/lib/data";
import { candidateTitles, folders, readMapping } from "@/lib/mapping";
import MappingManager from "../mapping-manager";
import CourseRename from "../course-rename";
import CourseNew from "../course-new";
import CourseLink from "../course-link";
import CourseDelete from "../course-delete";

export const dynamic = "force-dynamic"; // data changes as the backend records

export default function CoursesPage() {
  const list = courses().map((c) => {
    const ss = sessions(c);
    return { course: c, ss, start: semesterStartOf(c) };
  });
  const mapping = readMapping();
  const mappingSnap = { mapping, folders: folders(), candidates: candidateTitles(mapping) };

  return (
    <main>
      <h1>Courses</h1>
      <p className="muted">Meeting → folder mappings, and every course with its sessions.</p>
      <MappingManager initial={mappingSnap} />
      <CourseNew />

      {list.length === 0 && (
        <div className="card" style={{ marginTop: 12 }}>No courses yet — create one above or let the backend record a session.</div>
      )}
      {list.map(({ course, ss, start }) => (
        <details className="card" key={course} style={{ marginTop: 10 }} open={ss.length <= 3}>
          <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <CourseLink href={`/course/${encodeURIComponent(course)}`} label={course.replace(/_/g, " ")} />
            <CourseRename course={course} />
            <span className="muted">— {ss.length} session{ss.length === 1 ? "" : "s"}</span>
            {ss.length === 0 && <CourseDelete course={course} />}
          </summary>
          {ss.length === 0 ? (
            <p className="muted" style={{ margin: "8px 0 2px" }}>No sessions yet — ingest a recording from the course page, or wait for the next scheduled one.</p>
          ) : (
            <div style={{ margin: "8px 0 2px" }}>
              {ss.map((s) => {
                const w = start ? weekOf(s.date, start) : null;
                return (
                  <div key={s.stem} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}>
                    <span className="muted" style={{ fontSize: 13, minWidth: 90 }}>{s.date}{s.time ? ` ${s.time}` : ""}</span>
                    {w !== null && <span className="muted" style={{ fontSize: 12, minWidth: 60 }}>week {w}</span>}
                    <Link href={`/course/${encodeURIComponent(course)}/session/${encodeURIComponent(s.stem)}`} style={{ fontSize: 14 }}>
                      {s.stem.split("__").slice(1).join("__").replace(/_/g, " ") || s.stem}
                    </Link>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {s.audio ? "🎬" : ""}{s.hasTimeline ? "📝" : s.transcript ? "📄" : ""}{s.notes ? "🗒" : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </details>
      ))}
    </main>
  );
}
