"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** ✎ next to a course name — renames folders + remaps meetings. */
export default function CourseRename({ course }: { course: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const go = async (): Promise<void> => {
    const to = prompt(`Rename course '${course.replace(/_/g, " ")}' to:`, course.replace(/_/g, " "));
    if (!to?.trim() || to.trim().replace(/\s+/g, "_") === course) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/courses/${encodeURIComponent(course)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to.trim() }),
      });
      const j = (await r.json().catch(() => ({}))) as { slug?: string; error?: string };
      if (!r.ok || !j.slug) { alert(j.error ?? `rename failed (HTTP ${r.status})`); return; }
      // course page URL carries the slug — follow the rename
      router.push(`/course/${encodeURIComponent(j.slug)}`);
      router.refresh();
    } catch {
      alert("rename failed — backend unreachable");
    } finally {
      setBusy(false);
    }
  };

  return <button onClick={() => void go()} disabled={busy} title="Rename course (folders + meeting mappings follow)" style={{ fontSize: 12 }}>✎</button>;
}
