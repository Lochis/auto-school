"use client";
/** Course settings modal (icon + display name) opened from the course list
 *  rail — replaces the prompt()-based rename for the list entry. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { GhostButton, PrimaryButton } from "@/components/ui";
import { COURSE_ICONS, type CourseIconKey } from "./course-icons";

export default function CourseSettingsModal({
  slug,
  name,
  icon,
  onClose,
}: {
  slug: string;
  name: string;
  icon: string | null | undefined;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<CourseIconKey | null>(icon as CourseIconKey | null);
  const [to, setTo] = useState(name);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const clean = to.trim().replace(/\s+/g, "_");
      let next = slug;
      if (clean && clean !== slug) {
        const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: clean }),
        });
        const j = (await r.json().catch(() => ({}))) as { slug?: string; error?: string };
        if (r.ok && j.slug) next = j.slug;
        else if (!r.ok) { alert(j.error ?? `rename failed (HTTP ${r.status})`); setBusy(false); return; }
      }
      if (sel) {
        await fetch(`/api/courses/${encodeURIComponent(next)}/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ icon: sel }),
        });
      }
      router.refresh();
      onClose();
    } catch {
      alert("save failed — backend unreachable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Course settings">
        <div className="modal-head">
          <h3>Course settings</h3>
          <button className="iconbtn" onClick={onClose} title="Close" aria-label="Close">
            <XMarkIcon className="heroicon" />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="modal-label">Icon</span>
          <div className="icon-grid">
            {COURSE_ICONS.map((o) => (
              <button
                key={o.key}
                type="button"
                className={`icon-opt ${sel === o.key ? "icon-opt--active" : ""}`.trim()}
                onClick={() => setSel(o.key)}
                title={o.label}
                aria-label={o.label}
              >
                <o.Icon className="heroicon" />
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label className="modal-label" htmlFor="course-name">Name</label>
          <input
            id="course-name"
            className="modal-name"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder={name}
          />
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            Renaming renames the folder and remaps meeting titles — existing recordings follow.
          </span>
        </div>

        <div className="modal-actions">
          <GhostButton onClick={onClose} disabled={busy}>Cancel</GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}