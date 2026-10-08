"use client";
/** Delete-button for empty course folders (server refuses if sessions exist). */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { TrashIcon } from "@heroicons/react/24/outline";

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
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {err && <span className="muted" style={{ color: "var(--error)", fontSize: "0.6875rem" }}>{err}</span>}
      <button
        onClick={(e) => { e.stopPropagation(); void del(); }}
        disabled={busy}
        className="btn btn-destructive"
        style={{ padding: "3px 6px", minHeight: 24 }}
        title="Delete this course folder (only when it has no sessions)"
        aria-label={`Delete ${course}`}
      >
        {busy ? "…" : <TrashIcon className="heroicon" />}
      </button>
    </span>
  );
}
