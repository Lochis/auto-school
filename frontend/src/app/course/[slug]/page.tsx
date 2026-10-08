import Link from "next/link";
import { notFound } from "next/navigation";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { courses, sessions, DATA_DIR, type Session } from "@/lib/data";
import SessionCard from "./session-card";
import LazyNotes from "./lazy-notes";
import MaterialsTab from "./materials-tab";
import IngestForm from "./ingest-form";
import ChatTab from "./chat-tab";
import CourseRename from "../../course-rename";
import AudioPlayer from "@/components/sessions/audio-player";
import { CodeChip, Eyebrow, SegmentedTabs } from "@/components/ui";
import "../../sessions-ui.css";

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

/** Week (or month, when no semester anchor exists) grouping for the list. */
interface Group { key: string; title: string; label: string | null; current: boolean; sessions: Session[] }

export default async function CoursePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ tab?: string; prompt?: string }> }) {
  const { slug } = await params;
  const { tab, prompt } = await searchParams;
  if (!courses().includes(slug)) notFound();
  const all = courses(); // for the session move-to dropdown
  const list = sessions(slug);
  const showMaterials = tab === "materials";
  const showAsk = tab === "ask";
  const activeTab = showMaterials ? "materials" : showAsk ? "ask" : "sessions";

  const start = semesterStart(slug);
  const today = new Date().toISOString().slice(0, 10);
  const groups: Group[] = [];

  if (start) {
    const currentWeek = weekOf(today, start);
    const byWeek = new Map<number, Session[]>();
    for (const s of list) {
      const w = weekOf(s.date, start);
      const arr = byWeek.get(w) ?? [];
      arr.push(s);
      byWeek.set(w, arr);
    }
    for (const w of [...byWeek.keys()].sort((a, b) => b - a)) {
      const ws = byWeek.get(w) ?? [];
      groups.push({
        key: `w${w}`,
        title: `Week ${w}`,
        label: w === currentWeek ? "CURRENT SPRINT" : w < currentWeek ? `ARCHIVED · ${ws.length} RECORDING${ws.length === 1 ? "" : "S"}` : "UPCOMING",
        current: w === currentWeek,
        sessions: ws,
      });
    }
  } else {
    const byMonth = new Map<string, Session[]>();
    for (const s of list) {
      const k = s.date.slice(0, 7);
      const arr = byMonth.get(k) ?? [];
      arr.push(s);
      byMonth.set(k, arr);
    }
    const thisMonth = today.slice(0, 7);
    for (const k of [...byMonth.keys()].sort((a, b) => b.localeCompare(a))) {
      const ms = byMonth.get(k) ?? [];
      const title = new Date(`${k}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      groups.push({
        key: k,
        title,
        label: k === thisMonth ? "CURRENT MONTH" : k < thisMonth ? `ARCHIVED · ${ms.length} RECORDING${ms.length === 1 ? "" : "S"}` : "UPCOMING",
        current: k === thisMonth,
        sessions: ms,
      });
    }
  }

  // hash badge: leading "TERM-CODE" fragment, remainder becomes the display name
  const dashParts = slug.split("-");
  const codePart = dashParts.length >= 3 ? dashParts.slice(0, 2).join("-") : "";
  const namePart = (codePart ? dashParts.slice(2).join("-") : slug).replace(/_/g, " ").trim() || slug.replace(/_/g, " ");

  const latestAudio = list.find((s) => s.audio);

  return (
    <main>
      <div className="sess-page">
        <div className="breadcrumb">
          <div className="breadcrumb-trail">
            <Link href="/courses">← All Courses</Link>
          </div>
        </div>

        <div className="sess-hero">
          <div className="sess-hero-main">
            <div className="sess-hero-title-row">
              <h1>
                {namePart}
                {codePart && <span className="sess-hash"><CodeChip title="course code">{`# ${codePart}`}</CodeChip></span>}
                <CourseRename course={slug} />
              </h1>
            </div>
            <p className="sess-hero-sub muted">
              {list.length} session{list.length === 1 ? "" : "s"} indexed · recordings, transcripts &amp; AI notes
            </p>
            <SegmentedTabs
              variant="emerald"
              items={[
                { label: "Sessions", count: list.length, active: activeTab === "sessions", href: `/course/${slug}` },
                { label: "Materials", active: activeTab === "materials", href: `/course/${slug}?tab=materials` },
                { label: "Ask", active: activeTab === "ask", href: `/course/${slug}?tab=ask` },
              ]}
            />
          </div>
          <div className="ingest-dock">
            <IngestForm slug={slug} courses={all} semesterStart={start} />
          </div>
        </div>

        {showMaterials ? (
          <MaterialsTab slug={slug} />
        ) : showAsk ? (
          <ChatTab slug={slug} initialPrompt={prompt} />
        ) : (
          <>
            {!start && (
              <div className="callout">
                <span>💡</span>
                <span>
                  No semester anchor set — sessions group by month. Set a{" "}
                  <Link href={`/course/${slug}?tab=materials`}>semester start on the Materials tab</Link> to switch to week / sprint grouping.
                </span>
              </div>
            )}

            {latestAudio?.audio && <AudioPlayer course={slug} session={{ ...latestAudio, audio: latestAudio.audio }} />}

            {list.length === 0 && (
              <section className="panel">
                <h2 className="panel-title">No sessions indexed yet</h2>
                <p className="panel-sub">
                  Use the ingest button above to add a Teams recording, or wait for the daemon to capture a scheduled meeting.
                </p>
              </section>
            )}

            {groups.map((g) => (
              <section className="sess-week" key={g.key}>
                <div className="sess-week-head">
                  <div className="sess-week-head-left">
                    <span className={`sess-week-dot ${g.current ? "" : "sess-week-dot--archived"}`} />
                    <h2 className="sess-week-title">{g.title}</h2>
                    <span className="chip chip--pill">{g.sessions.length} session{g.sessions.length === 1 ? "" : "s"}</span>
                  </div>
                  {g.label && <Eyebrow tone={g.current ? "emerald" : "neutral"}>{g.label}</Eyebrow>}
                </div>
                <div className={`sess-week-grid ${g.sessions.length > 1 ? "sess-week-grid--multi" : ""}`}>
                  {g.sessions.map((s) => {
                    const hasText = Boolean(s.transcript || s.timeline);
                    return (
                      <article className="sess-card" key={s.stem}>
                        <SessionCard session={{ ...s, transcript: hasText ? (s.transcript ?? "timeline") : undefined }} course={slug} courses={all} />
                        {s.notes && <LazyNotes course={slug} stem={s.stem} kind="notes" segments={s.segmentCount} />}
                        {hasText && <LazyNotes course={slug} stem={s.stem} kind="transcript" segments={s.segmentCount} />}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </main>
  );
}
