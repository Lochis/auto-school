"use client";
/** Delete-button for empty course folders (server refuses if sessions exist). */
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CourseDelete({ course }: { course: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const router = useRouter();

  const del = async (): Promise<void> => {
    if (!confirm(`Delete the empty course folder "${course.replace(/_/g, " ")}"?\n(materials and config go too — this only works when there are no sessions)`)) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/courses/${encodeURIComponent(course)}`, { method: "DELETE" });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) setErr(j.error ?? `HTTP ${r.status}`);
      else router.refresh();
    } catch {
      setErr("unreachable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ marginLeft: "auto" }}>
      {err && <span className="muted" style={{ marginRight: 8, color: "#b91c1c" }}>{err}</span>}
      <button onClick={del} disabled={busy} title="Delete this course folder (only when it has no sessions)">
        {busy ? "…" : "✕"}
      </button>
    </span>
  );
}
