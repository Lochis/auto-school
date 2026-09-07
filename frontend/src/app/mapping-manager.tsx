"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Snapshot { mapping: Record<string, string>; folders: string[]; candidates: string[] }

/** Map meeting titles → course folders (writes <data>/mapping.json; the
 *  backend applies it to the next session it files). */
export default function MappingManager({ initial }: { initial: Snapshot }) {
  const [snap, setSnap] = useState(initial);
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

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
        body: JSON.stringify({ title, folder }),
      }));
  };

  const remove = (t: string) =>
    apply(() => fetch(`/api/mapping?title=${encodeURIComponent(t)}`, { method: "DELETE" }));

  const entries = Object.entries(snap.mapping);
  const isNewFolder = folder.trim().length > 0 && !snap.folders.includes(folder.trim().replace(/\s+/g, "_"));
  return (
    <div className="card">
      <h2 style={{ margin: 0 }}>Meeting → folder mapping</h2>
      <p className="muted" style={{ margin: "4px 0 10px" }}>
        Exact title match files a session under the folder you choose — overrides automatic course parsing.
        Typing a <strong>new folder name</strong> creates it (spaces → underscores).
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          list="candidate-titles" placeholder="meeting title…" value={title}
          onChange={(e) => setTitle(e.target.value)} style={{ flex: 2, minWidth: 200 }}
        />
        <input
          list="known-folders" placeholder="folder — pick or type a NEW one…" value={folder}
          onChange={(e) => setFolder(e.target.value)} style={{ flex: 1, minWidth: 180 }}
        />
        <button onClick={add} disabled={busy || !folder.trim()}>{isNewFolder ? "Map + create 📁" : "Map"}</button>
      </div>
      <datalist id="candidate-titles">
        {snap.candidates.map((t) => <option key={t} value={t} />)}
      </datalist>
      <datalist id="known-folders">
        {snap.folders.map((f) => <option key={f} value={f} />)}
      </datalist>
      {err && <p className="muted" style={{ color: "#ff8a8a" }}>{err}</p>}

      {entries.length > 0 ? (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
          <tbody>
            {entries.map(([t, f]) => (
              <tr key={t}>
                <td style={{ padding: "4px 8px" }}>{t}</td>
                <td className="muted" style={{ padding: "4px 8px" }}>→ {f}</td>
                <td style={{ textAlign: "right", padding: "4px 0" }}>
                  <button onClick={() => remove(t)} disabled={busy}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No manual mappings — everything filed by automatic parsing.</p>
      )}
    </div>
  );
}
