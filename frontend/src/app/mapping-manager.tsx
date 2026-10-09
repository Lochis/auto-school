"use client";
/** Meeting → Course Mapping (stitch restyle): pattern input + target folder
 *  select + cyan Link Match Rule button; rule rows link into the target
 *  course and remove with ✕. Writes <data>/mapping.json; the backend
 *  applies it to the next session it files. Typing a NEW folder name
 *  creates it (spaces → underscores). */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowsRightLeftIcon, FolderPlusIcon, LinkIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Chip, Panel } from "@/components/ui";

interface Snapshot { mapping: Record<string, string>; folders: string[]; candidates: string[] }

const NEW_FOLDER = "__new__";

export default function MappingManager({ initial }: { initial: Snapshot }) {
  const [snap, setSnap] = useState(initial);
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const target = folder === NEW_FOLDER ? newFolder.trim().replace(/\s+/g, "_") : folder;
  const isNewFolder = folder === NEW_FOLDER && newFolder.trim().length > 0;

  const apply = async (fn: () => Promise<Response>) => {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      const body = await r.json();
      if (!r.ok) setErr(body.error ?? `error ${r.status}`);
      else { setSnap(body); router.refresh(); }
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
  };

  const add = () => {
    if (!title.trim()) { setErr("pick a meeting title first"); return; }
    apply(() =>
      fetch("/api/mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, folder: target }),
      }));
  };

  const remove = (t: string) =>
    apply(() => fetch(`/api/mapping?title=${encodeURIComponent(t)}`, { method: "DELETE" }));

  const entries = Object.entries(snap.mapping);
  return (
    <Panel
      icon={<ArrowsRightLeftIcon className="heroicon" />}
      title="Meeting to Course Mappings"
      actions={<Chip title="active rules">{entries.length} Active</Chip>}
      subtitle="Exact title match files a session under the folder you choose. Overrides auto parsing."
    >
      <div className="map-form">
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <label className="map-label" htmlFor="map-pattern">Meeting Name Pattern</label>
          <input
            id="map-pattern"
            list="candidate-titles"
            placeholder="e.g. 26F - COMP3231 - Lecture"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <label className="map-label" htmlFor="map-folder">Target Directory Folder</label>
          <select
            id="map-folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          >
            <option value="">Select existing or type novel…</option>
            {snap.folders.map((f) => <option key={f} value={f}>{f}</option>)}
            <option value={NEW_FOLDER}>➕ create new folder…</option>
          </select>
          {folder === NEW_FOLDER && (
            <input
              autoFocus
              placeholder="new folder name (spaces → underscores)"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
            />
          )}
        </div>
        <button className="btn-cyan" onClick={add} disabled={busy || !folder || (folder === NEW_FOLDER && !newFolder.trim())}>
          {isNewFolder ? <><FolderPlusIcon className="heroicon" /> Link + Create Folder</> : <><LinkIcon className="heroicon" /> Link Match Rule</>}
        </button>
      </div>
      <datalist id="candidate-titles">
        {snap.candidates.map((t) => <option key={t} value={t} />)}
      </datalist>
      {err && <p className="muted" style={{ color: "var(--error)", margin: "8px 0 0" }}>{err}</p>}

      {entries.length > 0 ? (
        <div className="map-rows" style={{ marginTop: 12 }}>
          {entries.map(([t, f]) => (
            <div key={t} className="map-row">
              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span className="map-row-src" title={t}>{t}</span>
                <span className="map-row-dst" title={f}>
                  → <Link href={`/course/${encodeURIComponent(f)}`}>{f}</Link>
                </span>
              </div>
              <button onClick={() => remove(t)} disabled={busy} className="map-x" title="Delete mapping">
                <XMarkIcon className="heroicon" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: "12px 0 0" }}>No manual mappings — everything filed by automatic parsing.</p>
      )}
    </Panel>
  );
}
