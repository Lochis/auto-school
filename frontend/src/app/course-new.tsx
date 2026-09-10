"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Create a course shell — for courses whose Teams meetings the bot can't
 *  join yet. Upload materials + ingest recordings/transcripts by hand from
 *  the course page that opens after creation. */
export default function CourseNew() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (): Promise<void> => {
    if (!name.trim()) { setErr("give the course a name"); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/courses/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: name.trim(), semesterStart: start || undefined }),
      });
      const j = (await r.json().catch(() => ({}))) as { slug?: string; error?: string };
      if (!r.ok || !j.slug) { setErr(j.error ?? `create failed (HTTP ${r.status})`); return; }
      router.push(`/course/${encodeURIComponent(j.slug)}?tab=materials`);
      router.refresh();
    } catch {
      setErr("create failed — backend unreachable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 12 }}>
      <strong style={{ minWidth: 100 }}>New course</strong>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. COMP308 - Systems Programming" style={{ width: 280 }} />
      <label className="muted" style={{ fontSize: 13 }}>
        semester starts:
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={{ marginLeft: 6, width: 150 }} />
      </label>
      <button onClick={() => void submit()} disabled={busy}>Create</button>
      <span className="muted" style={{ fontSize: 12 }}>for courses without bot access — upload materials + recordings yourself</span>
      {err && <span style={{ color: "#b91c1c", fontSize: 13 }}>{err}</span>}
    </div>
  );
}
