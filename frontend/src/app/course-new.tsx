"use client";
/** Inline register form for the Registered Course Repositories panel —
 *  for courses whose Teams meetings the bot can't join yet. Upload
 *  materials + ingest recordings/transcripts by hand from the course page
 *  that opens after creation. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderPlusIcon } from "@heroicons/react/24/outline";
import { PrimaryButton } from "@/components/ui";

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
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div className="register-form">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. COMP308 – Systems Programming"
          style={{ width: 240 }}
          aria-label="Course code and name"
        />
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          title="Semester starts: YYYY-MM-DD — anchors week numbering"
          aria-label="Semester starts"
        />
        <PrimaryButton icon={<FolderPlusIcon className="heroicon" />} onClick={() => void submit()} disabled={busy}>
          {busy ? "Registering…" : "Register Course"}
        </PrimaryButton>
      </div>
      <span className="muted" style={{ fontSize: "0.6875rem" }}>
        {err ? <span style={{ color: "var(--error)" }}>{err}</span> : "for courses without bot access — upload materials + recordings yourself"}
      </span>
    </div>
  );
}
