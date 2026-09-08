"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

/** Ingest form — bring a Teams recording (+ optional transcript) into the
 *  course.  Week # + course → backend derives the standard
 *  `<date>__<course>__<HHMMSS>.mp4` stem so it shows up as a native session
 *  (player, transcript, week grouping) with zero extra plumbing. */
function weekMonday(dstr: string): string {
  const d = new Date(`${dstr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

export default function IngestForm({ slug, courses, semesterStart }: {
  slug: string;
  courses: string[];
  semesterStart: string | null;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState<File | null>(null);
  const [course, setCourse] = useState(slug);
  const [week, setWeek] = useState<number>(1);
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const hasStart = /^\d{4}-\d{2}-\d{2}$/.test(semesterStart ?? "");

  // weeks with their Monday dates, for the preview
  const weekOptions = useMemo(() => {
    if (!hasStart) return [];
    return Array.from({ length: 15 }, (_, i) => {
      const mon = new Date(`${weekMonday(semesterStart!)}T00:00:00Z`);
      mon.setUTCDate(mon.getUTCDate() + i * 7);
      const end = new Date(mon); end.setUTCDate(end.getUTCDate() + 4);
      const f = (d: Date) => d.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
      return { week: i + 1, label: `week ${i + 1} (${f(mon)}–${f(end)})`, date: mon.toISOString().slice(0, 10) };
    });
  }, [semesterStart, hasStart]);

  const derivedDate = weekOptions.find((w) => w.week === week)?.date ?? new Date().toISOString().slice(0, 10);
  const preview = file ? `${derivedDate}__${course || "?"}__<time>.mp4` : null;

  const submit = async () => {
    if (!file || !course.trim()) { setMsg("pick a video and course"); return; }
    setBusy(true); setMsg("uploading…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (transcript) fd.append("transcript", transcript);
      fd.append("course", course.trim().replace(/\s+/g, "_"));
      fd.append("week", String(week));
      const res = await fetch("/api/ingest", { method: "POST", body: fd });
      const j = await res.json();
      if (!j.ok) { setMsg(`error: ${j.error}`); setBusy(false); return; }
      setMsg(`ingested ${j.mp4}${j.transcript ? " + transcript" : ""}`);
      // no uploaded transcript → kick off Gemini video analysis in the background
      if (!j.transcript && autoTranscribe) {
        setMsg(`ingested ${j.mp4} — transcribing…`);
        await fetch(`/api/transcribe?course=${encodeURIComponent(j.course)}&stem=${encodeURIComponent(j.stem)}`, { method: "POST" }).catch(() => {});
        setMsg(`ingested ${j.mp4} — transcription running (see home activity feed)`);
      }
      setFile(null); setTranscript(null);
      router.refresh();
    } catch {
      setMsg("upload failed — backend unreachable");
    }
    setBusy(false);
  };

  return (
    <details className="card" style={{ marginBottom: 14 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>＋ Ingest a Teams recording</summary>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontWeight: 600 }}>Video</label>
          <input type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <label style={{ fontWeight: 600 }}>Transcript (optional)</label>
          <input type="file" accept=".txt,.md,.vtt" onChange={(e) => setTranscript(e.target.files?.[0] ?? null)} />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label htmlFor="ig-course" style={{ fontWeight: 600 }}>Course folder</label>
          <input id="ig-course" list="ig-courses" value={course} onChange={(e) => setCourse(e.target.value)}
            style={{ padding: "4px 8px", width: 220 }} />
          <datalist id="ig-courses">{courses.map((c) => <option key={c} value={c} />)}</datalist>
          {hasStart ? (
            <>
              <label htmlFor="ig-week" style={{ fontWeight: 600 }}>Week</label>
              <select id="ig-week" value={week} onChange={(e) => setWeek(Number(e.target.value))} style={{ padding: "4px 8px" }}>
                {weekOptions.map((w) => <option key={w.week} value={w.week}>{w.label}</option>)}
              </select>
            </>
          ) : <span className="muted">set a semester start (Materials tab) to pick weeks — otherwise today&apos;s date is used</span>}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={autoTranscribe} onChange={(e) => setAutoTranscribe(e.target.checked)} />
            auto-transcribe with Gemini when no transcript uploaded
          </label>
          <button onClick={submit} disabled={busy || !file}>Upload</button>
          {preview && <span className="muted">→ {preview}</span>}
          {msg && <span className="muted">{msg}</span>}
        </div>
      </div>
    </details>
  );
}
