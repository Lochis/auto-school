"use client";
/**
 * Materials explorer: real folder tree, folder-aware drag-drop upload
 * (webkitRelativePath preserved → backend keeps subpaths; "Week N" folders
 * auto-tag weeks), inline rename, delete files OR folders.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Entry {
  path: string;
  filename: string;
  week: number | null;
  category: string;
  description: string;
  uploadedAt: string;
  size: number;
}

/** Build a nested tree from flat entries. */
interface TNode {
  name: string;
  path: string;
  children: Map<string, TNode>;
  file?: Entry;
}
function buildTree(entries: Entry[]): TNode {
  const root: TNode = { name: "", path: "", children: new Map() };
  for (const e of entries) {
    let cur = root;
    const segs = e.path.split("/");
    segs.forEach((seg, i) => {
      const p = segs.slice(0, i + 1).join("/");
      if (!cur.children.has(seg)) cur.children.set(seg, { name: seg, path: p, children: new Map() });
      cur = cur.children.get(seg)!;
      if (i === segs.length - 1) cur.file = e; // leaf
    });
  }
  return root;
}

const fmtSize = (b: number): string => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export default function MaterialsTab({ slug }: { slug: string }) {
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [week, setWeek] = useState<number | "">("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/courses/${encodeURIComponent(slug)}/materials`)
      .then((r) => r.json())
      .then((j: { materials?: Entry[]; error?: string }) => {
        if (j.materials) setEntries(j.materials);
        else setLoadErr(j.error ?? "failed to load");
      })
      .catch(() => setLoadErr("backend unreachable"));
  }, [slug]);

  const upload = async (files: FileList, subpaths?: string[]): Promise<void> => {
    if (!files.length) return;
    setBusy(true);
    setLoadErr("");
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("file", f);
      // per-file subpaths (folder drop → webkitRelativePath), else bare names
      const paths = subpaths ?? Array.from(files).map((f) => f.name);
      paths.forEach((p, i) => fd.append(`path${i}`, p));
      if (week !== "") fd.append("week", String(week));
      const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/materials`, { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) setLoadErr(j.error ?? `HTTP ${r.status}`);
      else router.refresh();
    } catch {
      setLoadErr("upload failed");
    } finally {
      setBusy(false);
    }
  };

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    const items = Array.from(e.dataTransfer.items).filter((i) => i.webkitGetAsEntry?.());
    const files: File[] = [];
    const paths: string[] = [];
    // resolve directory entries recursively (folder drop)
    const walk = (entry: FileSystemEntry, prefix: string, done: () => void): void => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file((f) => {
          files.push(f);
          paths.push(prefix + f.name);
          done();
        });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const readBatch = (): void => {
          reader.readEntries(async (batch) => {
            if (!batch.length) { done(); return; }
            let pending = batch.length;
            const childDone = (): void => { if (--pending === 0) readBatch(); };
            for (const child of batch) walk(child, `${prefix}${entry.name}/`, childDone);
          });
        };
        readBatch();
      } else done();
    };
    const entriesList = items.map((i) => i.webkitGetAsEntry!()).filter(Boolean) as FileSystemEntry[];
    let pending = entriesList.length;
    await new Promise<void>((resolve) => {
      if (!pending) return resolve();
      for (const en of entriesList) {
        walk(en, "", () => { if (--pending === 0) resolve(); });
      }
    });
    if (files.length) {
      // wrap in a FileList-ish and upload with paths
      const fd = new FormData();
      for (const f of files) fd.append("file", f);
      paths.forEach((p, i) => fd.append(`path${i}`, p));
      if (week !== "") fd.append("week", String(week));
      setBusy(true);
      try {
        const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/materials`, { method: "POST", body: fd });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) setLoadErr(j.error ?? `HTTP ${r.status}`);
        else router.refresh();
      } catch { setLoadErr("upload failed"); }
      finally { setBusy(false); }
    }
  };

  const rename = async (from: string): Promise<void> => {
    const to = renameTo.trim();
    setRenaming(null);
    if (!to || to === from) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/materials`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) setLoadErr(j.error ?? `HTTP ${r.status}`);
      else router.refresh();
    } catch { setLoadErr("rename failed"); }
    finally { setBusy(false); }
  };

  const del = async (path: string): Promise<void> => {
    if (!confirm(`Delete "${path}"?${entries.some((e) => e.path.startsWith(path + "/")) ? "\n\nThis is a FOLDER — everything inside goes too." : ""}`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/materials?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      if (r.ok) router.refresh();
      else setLoadErr(`HTTP ${r.status}`);
    } catch { setLoadErr("delete failed"); }
    finally { setBusy(false); }
  };

  // semester start editor (kept from the old tab)
  const [semStart, setSemStart] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/courses/${encodeURIComponent(slug)}/config`)
      .then((r) => r.json())
      .then((j: { semesterStart?: string }) => setSemStart(j.semesterStart ?? ""))
      .catch(() => setSemStart(""));
  }, [slug]);
  const saveStart = async (): Promise<void> => {
    setBusy(true);
    try {
      await fetch(`/api/courses/${encodeURIComponent(slug)}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ semesterStart: semStart }),
      });
      router.refresh();
    } finally { setBusy(false); }
  };

  const tree = buildTree(entries);

  const renderNode = (n: TNode, depth: number): React.ReactNode => {
    const isFolder = n.children.size > 0 || !n.file;
    if (isFolder && n.name) {
      return (
        <details key={n.path} open={depth < 2} style={{ marginLeft: depth * 16 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600, padding: "3px 0" }}>
            📁 {n.name}
            <button onClick={(e) => { e.preventDefault(); setRenaming(n.path); setRenameTo(n.path); }} title="Rename folder" style={{ marginLeft: 8, fontSize: 11 }}>✎</button>
            <button onClick={(e) => { e.preventDefault(); del(n.path); }} title="Delete folder" style={{ marginLeft: 4, fontSize: 11 }}>🗑</button>
          </summary>
          {renaming === n.path && (
            <div style={{ margin: "4px 0" }}>
              <input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} style={{ width: 320 }} placeholder="new path (folders with /)" />
              <button onClick={() => rename(n.path)} disabled={busy}>Save</button>
              <button onClick={() => setRenaming(null)}>Cancel</button>
            </div>
          )}
          {[...n.children.values()].sort((a, b) => (a.children.size === b.children.size ? a.name.localeCompare(b.name) : b.children.size - a.children.size)).map((c) => renderNode(c, depth + 1))}
        </details>
      );
    }
    if (n.file) {
      const f = n.file;
      return (
        <div key={f.path} style={{ marginLeft: depth * 16, display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}>
          <span>📄 {f.filename}</span>
          {f.week !== null && <span className="muted" style={{ fontSize: 12 }}>· week {f.week}</span>}
          <span className="muted" style={{ fontSize: 12 }}>{fmtSize(f.size)}</span>
          <button onClick={() => { setRenaming(f.path); setRenameTo(f.path); }} title="Rename/move" style={{ fontSize: 11 }}>✎</button>
          <button onClick={() => del(f.path)} title="Delete" style={{ fontSize: 11 }}>🗑</button>
          {renaming === f.path && (
            <span>
              <input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} style={{ width: 320 }} placeholder="new path" />
              <button onClick={() => rename(f.path)} disabled={busy}>Save</button>
              <button onClick={() => setRenaming(null)}>Cancel</button>
            </span>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <div>
      {/* upload controls */}
      <div className="card" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}
           onDragOver={(e) => e.preventDefault()} onDrop={(e) => { void onDrop(e); }}
           title="Drop files or whole folders here">
        <strong style={{ minWidth: 80 }}>Materials</strong>
        <span className="muted" style={{ fontSize: 13 }}>drop files / folders here →</span>
        <label className="muted" style={{ fontSize: 13 }}>
          week (for loose files):
          <select value={week} onChange={(e) => setWeek(e.target.value === "" ? "" : Number(e.target.value))} style={{ marginLeft: 6 }}>
            <option value="">folder name decides</option>
            {Array.from({ length: 15 }, (_, i) => i + 1).map((w) => <option key={w} value={w}>week {w}</option>)}
          </select>
        </label>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        <input ref={folderRef} type="file" multiple hidden // @ts-expect-error non-standard
               webkitdirectory="" directory="" onChange={(e) => {
                 const fl = e.target.files;
                 if (!fl) return;
                 const paths = Array.from(fl).map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
                 upload(fl, paths);
               }} />
        <button onClick={() => fileRef.current?.click()} disabled={busy}>+ Files</button>
        <button onClick={() => folderRef.current?.click()} disabled={busy}>+ Folder</button>
        {busy && <span className="muted">working…</span>}
      </div>

      {/* semester start */}
      <div className="card" style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <span className="muted" style={{ fontSize: 13 }}>Semester starts:</span>
        <input type="date" value={semStart ?? ""} onChange={(e) => setSemStart(e.target.value)} style={{ width: 160 }} />
        <button onClick={saveStart} disabled={busy || !semStart}>Save</button>
        <span className="muted" style={{ fontSize: 12 }}>— used to group sessions + weeks on this page</span>
      </div>

      {loadErr && <p style={{ color: "#b91c1c" }}>{loadErr}</p>}

      {/* tree */}
      <div className="card" style={{ marginTop: 10, maxHeight: "60vh", overflow: "auto" }}>
        {entries.length === 0 ? (
          <p className="muted">No materials yet — drop files or a whole course folder above. Folders named “Week 1”, “week-3” etc. tag their contents automatically.</p>
        ) : (
          [...tree.children.values()].sort((a, b) => (a.children.size === b.children.size ? a.name.localeCompare(b.name) : b.children.size - a.children.size)).map((c) => renderNode(c, 0))
        )}
      </div>
    </div>
  );
}
