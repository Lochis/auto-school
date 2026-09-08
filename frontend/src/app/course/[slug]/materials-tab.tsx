"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const CATEGORIES = ["syllabus", "assignment", "lecture-notes", "reference", "rubric", "other"] as const;
type Cat = typeof CATEGORIES[number];
const CAT_COLORS: Record<Cat, string> = {
  syllabus: "#3b82f6", assignment: "#f59e0b", "lecture-notes": "#10b981",
  reference: "#8b5cf6", rubric: "#ec4899", other: "#6b7280",
};

interface Material { filename: string; week: number; category: Cat; description: string; uploadedAt: string; size: number; }

const fmt = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
const api = (slug: string) => `/api/courses/${encodeURIComponent(slug)}/materials`;
const cfgApi = (slug: string) => `/api/courses/${encodeURIComponent(slug)}/config`;
const fileUrl = (slug: string, m: Material) =>
  `/api/media/courses/${encodeURIComponent(slug)}/materials/week-${String(m.week).padStart(2, "0")}/${encodeURIComponent(m.filename)}`;

/** Monday of the week containing a YYYY-MM-DD. */
function weekMonday(dstr: string): string {
  const d = new Date(`${dstr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}
function weekOf(dstr: string, start: string): number {
  const a = Date.parse(`${weekMonday(dstr)}T00:00:00Z`), b = Date.parse(`${weekMonday(start)}T00:00:00Z`);
  return Math.max(1, Math.floor((a - b) / 604_800_000) + 1);
}

export default function MaterialsTab({ slug }: { slug: string }) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [semesterStart, setSemesterStart] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [category, setCategory] = useState<Cat>("other");
  const [week, setWeek] = useState<number | null>(null); // null until derived from config
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, c] = await Promise.all([
        fetch(api(slug)).then((r) => r.json()),
        fetch(cfgApi(slug)).then((r) => r.json()),
      ]);
      setMaterials(Array.isArray(m) ? m : []);
      const ss: string = c?.semesterStart ?? "";
      setSemesterStart(ss);
      // default week = auto-derived from semesterStart + today
      setWeek(/^\d{4}-\d{2}-\d{2}$/.test(ss) ? weekOf(new Date().toISOString().slice(0, 10), ss) : 1);
    } catch { setMaterials([]); }
    setLoading(false);
  }, [slug]);
  useEffect(() => { load(); }, [load]);

  const saveStart = async (val: string) => {
    setSemesterStart(val);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return;
    try {
      await fetch(cfgApi(slug), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ semesterStart: val }) });
      setWeek(weekOf(new Date().toISOString().slice(0, 10), val));
      setMsg(`semester starts ${val} — weeks derived`);
    } catch { setMsg("couldn't save semester start"); }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length || !week) return;
    setUploading(true); setMsg(null);
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", category);
      fd.append("description", description);
      fd.append("week", String(week));
      try {
        const res = await fetch(api(slug), { method: "POST", body: fd });
        const j = await res.json();
        if (j.ok) setMsg(`uploaded ${j.filename} → week ${j.week}`); else setMsg(`error: ${j.error}`);
      } catch { setMsg("upload failed — backend unreachable"); }
    }
    setDescription("");
    setUploading(false);
    load();
  };

  const del = async (m: Material) => {
    if (!confirm(`Delete ${m.filename} (week ${m.week})?`)) return;
    await fetch(`${api(slug)}?file=${encodeURIComponent(m.filename)}&week=${m.week}`, { method: "DELETE" });
    load();
  };

  const drop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); };

  // group by week (descending = newest first)
  const byWeek = new Map<number, Material[]>();
  for (const m of materials) {
    const arr = byWeek.get(m.week) ?? [];
    arr.push(m);
    byWeek.set(m.week, arr);
  }
  const weeks = [...byWeek.keys()].sort((a, b) => b - a);

  return (
    <div className="card">
      <h2 style={{ margin: "0 0 12px" }}>Course Materials</h2>

      {/* semester anchor — drives week derivation for materials AND sessions */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <label htmlFor="semstart" style={{ fontWeight: 600 }}>Semester starts</label>
        <input id="semstart" type="date" value={semesterStart} onChange={(e) => saveStart(e.target.value)} style={{ padding: "4px 8px" }} />
        <span className="muted">Week 1 = the week containing this date (drives week grouping)</span>
      </div>

      {/* upload zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={drop}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? "#3b82f6" : "#d1d5db"}`,
          borderRadius: 8, padding: 20, textAlign: "center", cursor: "pointer",
          background: dragOver ? "#eff6ff" : "transparent", marginBottom: 16,
        }}
      >
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        {uploading ? <span className="muted">uploading…</span> : <span>Drop files here or click to browse → week {week ?? "?"}</span>}
      </div>

      {/* week + category + description */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <label htmlFor="wk" style={{ fontWeight: 600 }}>Week</label>
        <select id="wk" value={week ?? 1} onChange={(e) => setWeek(Number(e.target.value))} style={{ padding: "4px 8px" }}>
          {Array.from({ length: 15 }, (_, i) => i + 1).map((w) => <option key={w} value={w}>week {w}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value as Cat)} style={{ padding: "4px 8px" }}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          type="text" placeholder="optional description…" value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ flex: "1 1 200px", padding: "4px 8px" }}
        />
        {msg && <span className="muted">{msg}</span>}
      </div>

      {/* file list grouped by week */}
      {loading ? <p className="muted">loading…</p> : weeks.length === 0
        ? <p className="muted">no materials yet — drop a syllabus, assignments, or lecture notes above.</p>
        : weeks.map((w) => (
          <div key={w} style={{ marginBottom: 14 }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Week {w}</h3>
            <div style={{ display: "grid", gap: 6 }}>
              {(byWeek.get(w) ?? []).map((m) => (
                <div key={`${m.week}/${m.filename}`} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 6 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, color: "#fff", background: CAT_COLORS[m.category],
                    padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap",
                  }}>{m.category}</span>
                  <a href={fileUrl(slug, m)} target="_blank" rel="noreferrer" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#2563eb" }}>
                    {m.filename}
                  </a>
                  {m.description && <span className="muted" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>— {m.description}</span>}
                  <span className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(m.size)}</span>
                  <button onClick={() => del(m)} style={{ fontSize: 12, padding: "2px 6px" }}>×</button>
                </div>
              ))}
            </div>
          </div>
        ))
      }
    </div>
  );
}
