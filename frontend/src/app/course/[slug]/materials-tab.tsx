"use client";
/**
 * Materials tab — Stitch screen 4 (course_materials_file_explorer):
 * stat strip, drag-drop upload panel (folder drops preserve subpaths;
 * "Week N" folders auto-tag weeks), semester anchor toolbar, hierarchical
 * file explorer table with multi-select zip download, sync-daemon strip and
 * an Ask AI CTA. All data comes from the real materials / config / status
 * APIs — nothing is mocked.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ChevronUpDownIcon,
  CircleStackIcon,
  CloudArrowUpIcon,
  FolderIcon,
  FolderPlusIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import { GhostButton, LiveDot, Panel, PrimaryButton, StatCard } from "@/components/ui";
import { buildTree, fmtSize, kindFor, type Entry, type TNode } from "@/components/materials/file-meta";
import FileTree from "@/components/materials/file-tree";
import { useStatus } from "@/lib/use-status";
import "../../materials-ui.css";

export default function MaterialsTab({ slug }: { slug: string }) {
  const router = useRouter();
  const status = useStatus();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [week, setWeek] = useState<number | "">("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // ── multi-select download: exact file paths; folders expand server-side ──
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggleFile = (p: string): void =>
    setSel((m) => {
      const n = new Set(m);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const toggleFolderSel = (paths: string[]): void => {
    // direction computed INSIDE the updater — never a stale-closure mis-toggle
    setSel((m) => {
      const all = paths.length > 0 && paths.every((p) => m.has(p));
      const nm = new Set(m);
      for (const p of paths) {
        if (all) nm.delete(p);
        else nm.add(p);
      }
      return nm;
    });
  };
  const selSize = entries.filter((e) => sel.has(e.path)).reduce((n, e) => n + e.size, 0);
  /** collapse fully-selected folders to their folder path — shorter URLs; the
   *  backend expands folders recursively anyway */
  const downloadUrl = (): string => {
    const picked = entries.filter((e) => sel.has(e.path));
    const rels = new Set(picked.map((f) => f.path));
    outer: for (const f of picked) {
      const segs = f.path.split("/");
      for (let i = segs.length - 1; i >= 1; i--) {
        const dir = segs.slice(0, i).join("/");
        const inDir = entries.filter((e) => e.path.startsWith(dir + "/"));
        if (inDir.length && inDir.every((e) => sel.has(e.path))) {
          for (const e of inDir) rels.delete(e.path);
          rels.add(dir);
          continue outer;
        }
      }
    }
    return `/api/courses/${encodeURIComponent(slug)}/materials/download?` + [...rels].map((r) => `p=${encodeURIComponent(r)}`).join("&");
  };

  const reload = (): void => {
    fetch(`/api/courses/${encodeURIComponent(slug)}/materials`)
      .then((r) => r.json())
      .then((j: { materials?: Entry[]; error?: string }) => {
        if (j.materials) {
          setEntries(j.materials);
          setLoadErr("");
        } else setLoadErr(j.error ?? "failed to load");
      })
      .catch(() => setLoadErr("backend unreachable"));
  };
  useEffect(reload, [slug]);

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
      else {
        reload();
        router.refresh();
      }
    } catch {
      setLoadErr("upload failed");
    } finally {
      setBusy(false);
    }
  };

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDragOver(false);
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
            if (!batch.length) {
              done();
              return;
            }
            let pending = batch.length;
            const childDone = (): void => {
              if (--pending === 0) readBatch();
            };
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
        walk(en, "", () => {
          if (--pending === 0) resolve();
        });
      }
    });
    if (files.length) {
      const fd = new FormData();
      for (const f of files) fd.append("file", f);
      paths.forEach((p, i) => fd.append(`path${i}`, p));
      if (week !== "") fd.append("week", String(week));
      setBusy(true);
      try {
        const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/materials`, { method: "POST", body: fd });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) setLoadErr(j.error ?? `HTTP ${r.status}`);
        else {
          reload();
          router.refresh();
        }
      } catch {
        setLoadErr("upload failed");
      } finally {
        setBusy(false);
      }
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
      else {
        reload();
        router.refresh();
      }
    } catch {
      setLoadErr("rename failed");
    } finally {
      setBusy(false);
    }
  };

  const del = async (path: string): Promise<void> => {
    if (
      !confirm(
        `Delete "${path}"?${
          entries.some((e) => e.path.startsWith(path + "/")) ? "\n\nThis is a FOLDER — everything inside goes too." : ""
        }`,
      )
    )
      return;
    setBusy(true);
    try {
      const r = await fetch(`/api/courses/${encodeURIComponent(slug)}/materials?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      if (r.ok) {
        reload();
        router.refresh();
      } else setLoadErr(`HTTP ${r.status}`);
    } catch {
      setLoadErr("delete failed");
    } finally {
      setBusy(false);
    }
  };

  // ── semester start anchor (config API) ──
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
    } finally {
      setBusy(false);
    }
  };

  // ── derived stats ──
  const tree = useMemo(() => buildTree(entries), [entries]);
  const fileCount = entries.length;
  const folderCount = useMemo(() => {
    let c = 0;
    const walk = (n: TNode): void => {
      for (const ch of n.children.values()) {
        if (!ch.file) {
          c++;
          walk(ch);
        }
      }
    };
    walk(tree);
    return c;
  }, [tree]);
  const totalSize = useMemo(() => entries.reduce((n, e) => n + e.size, 0), [entries]);
  // the drop zone accepts archives too — surface the accepted formats, not the
  // extension histogram of what happens to be stored already
  const formats = "ZIP / PDF / DOCX / MP4";
  const anchorLabel = useMemo(() => {
    if (semStart === null) return "…";
    if (!semStart) return "not set";
    const d = new Date(`${semStart}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? semStart : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }, [semStart]);

  // ── tree visibility / bulk actions ──
  const allPaths = useMemo(() => entries.map((e) => e.path), [entries]);
  const visiblePaths = useMemo(() => {
    const out: string[] = [];
    const walk = (n: TNode, hidden: boolean): void => {
      for (const c of n.children.values()) {
        if (c.file) {
          if (!hidden) out.push(c.file.path);
        } else walk(c, hidden || collapsed.has(c.path));
      }
    };
    walk(tree, false);
    return out;
  }, [tree, collapsed]);
  const allSelected = fileCount > 0 && sel.size === fileCount;
  const someSelected = sel.size > 0 && !allSelected;

  // ── daemon strip (real state from the shared status poller) ──
  const online = status !== null && status.online !== false;
  const daemonLabel = status === null ? "connecting…" : online ? (status.state ? status.state[0].toUpperCase() + status.state.slice(1) : "Online") : "Offline";
  const lastScanLabel = useMemo(() => {
    const ls = status?.lastScan;
    if (!ls) return null;
    const t = Date.parse(ls);
    if (Number.isNaN(t)) return null;
    const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
    if (mins < 1) return "last scan just now";
    if (mins < 60) return `last scan ${mins}m ago`;
    return `last scan ${Math.round(mins / 60)}h ago`;
  }, [status?.lastScan]);

  return (
    <div className="mat-page">
      {/* ── stat strip ── */}
      <div className="mat-stats">
        <StatCard
          label="Total Artifacts"
          value={
            <>
              {fileCount} File{fileCount === 1 ? "" : "s"} <span className="mat-stat-sub">/ {folderCount} Folder{folderCount === 1 ? "" : "s"}</span>
            </>
          }
          tone="emerald"
          icon={<FolderIcon className="heroicon" />}
        />
        <StatCard
          label="Indexed Footprint"
          value={
            <>
              {fmtSize(totalSize)} <span className="mat-stat-sub">processed</span>
            </>
          }
          tone="cyan"
          icon={<CircleStackIcon className="heroicon" />}
        />
        <StatCard
          label="Semantic Parser"
          value={
            <span className="mat-parser">
              <LiveDot tone={status === null ? undefined : online ? "emerald" : "red"} />
              {status === null ? "Connecting…" : online ? "Ask Pipeline Ready" : "Daemon Offline"}
            </span>
          }
          tone={status === null ? "neutral" : online ? "emerald" : "red"}
          icon={<SparklesIcon className="heroicon" />}
        />
        <StatCard
          label="Active Semester Anchor"
          value={anchorLabel}
          tone={semStart ? "indigo" : "neutral"}
          icon={<CalendarDaysIcon className="heroicon" />}
        />
      </div>

      {/* ── upload panel: drop zone + actions + semester toolbar ── */}
      <Panel>
        <div className="mat-upload-top">
          <div
            className={`mat-dropzone${dragOver ? " dragover" : ""}`}
            role="button"
            tabIndex={0}
            title="Drop files or whole folders here"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              void onDrop(e);
            }}
          >
            <span className="icon-tile icon-tile--lg icon-tile--emerald">
              <CloudArrowUpIcon className="heroicon" style={{ width: 18, height: 18 }} />
            </span>
            <div className="mat-drop-copy">
              <div className="mat-drop-title">
                Drop files or folders here <span className="mat-drop-or">— or browse your machine</span>
              </div>
              <div className="mat-drop-sub">folder structure is preserved · “Week N” folders auto-tag weeks · indexed for Ask AI</div>
            </div>
            <span className="chip chip--cyan mat-drop-formats">{formats}</span>
          </div>

          <div className="mat-upload-actions">
            <label className="muted" style={{ fontSize: 13 }}>
              week (for loose files):
              <select value={week} onChange={(e) => setWeek(e.target.value === "" ? "" : Number(e.target.value))} style={{ marginLeft: 6 }}>
                <option value="">folder name decides</option>
                {Array.from({ length: 15 }, (_, i) => i + 1).map((w) => (
                  <option key={w} value={w}>
                    week {w}
                  </option>
                ))}
              </select>
            </label>
            <PrimaryButton icon={<ArrowUpTrayIcon className="heroicon" />} onClick={() => fileRef.current?.click()} disabled={busy}>
              Upload
            </PrimaryButton>
            <GhostButton icon={<FolderPlusIcon className="heroicon" />} onClick={() => folderRef.current?.click()} disabled={busy} title="pick a whole folder — subpaths are preserved">
              New Folder
            </GhostButton>
            {busy && <span className="muted">working…</span>}
          </div>

          <div className="mat-semtoolbar">
            <div className="mat-sem-left">
              <span className="mat-sem-label">
                <CalendarDaysIcon className="heroicon" />
                Semester starts:
              </span>
              <input className="mat-sem-input" type="date" value={semStart ?? ""} onChange={(e) => setSemStart(e.target.value)} aria-label="semester start date" />
              <GhostButton className="btn-micro" onClick={saveStart} disabled={busy || !semStart}>
                Save
              </GhostButton>
              <span className="mat-sem-help">— calculates dynamic week offsets &amp; associates session recordings</span>
            </div>
            <div className="mat-sem-right">
              <button type="button" className="mat-linkbtn" onClick={() => setCollapsed(new Set())}>
                <ChevronUpDownIcon className="heroicon" />
                Expand All
              </button>
              <button type="button" className="mat-linkbtn" onClick={() => toggleFolderSel(visiblePaths)} disabled={visiblePaths.length === 0}>
                <CheckIcon className="heroicon" />
                Select Visible
              </button>
            </div>
          </div>
        </div>

        <input ref={fileRef} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        <input
          ref={folderRef}
          type="file"
          multiple
          hidden
          // @ts-expect-error non-standard
          webkitdirectory=""
          directory=""
          onChange={(e) => {
            const fl = e.target.files;
            if (!fl) return;
            const paths = Array.from(fl).map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
            upload(fl, paths);
          }}
        />
      </Panel>

      {/* ── file explorer table ── */}
      <section className="panel mat-explorer">
        {sel.size > 0 && (
          <div className="mat-selbar">
            <span>
              {sel.size} selected · {fmtSize(selSize)}
            </span>
            <PrimaryButton
              icon={<ArrowDownTrayIcon className="heroicon" />}
              onClick={() => {
                window.location.href = downloadUrl();
              }}
              disabled={busy}
              title="download the selection (single file as-is, several files/folders as a zip)"
            >
              Download ({sel.size})
            </PrimaryButton>
            <GhostButton className="btn-micro" onClick={() => setSel(new Set())}>
              Clear
            </GhostButton>
          </div>
        )}
        <div className="mat-head">
          <div className="mat-name">
            <input
              type="checkbox"
              className="selbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected;
              }}
              onChange={() => toggleFolderSel(allPaths)}
              aria-label="select all materials"
              disabled={fileCount === 0}
            />
            <span>Name &amp; Hierarchy</span>
          </div>
          <span className="mat-col mat-col--cat">Category</span>
          <span className="mat-col mat-col--size">Size</span>
          <span className="mat-col mat-col--act">Actions</span>
        </div>
        {loadErr && <p className="mat-err">{loadErr}</p>}
        <div className="mat-body">
          {entries.length === 0 ? (
            <p className="muted mat-empty">
              No materials yet — drop files or a whole course folder above. Folders named “Week 1”, “week-3” etc. tag their contents automatically.
            </p>
          ) : (
            <FileTree
              root={tree}
              slug={slug}
              collapsed={collapsed}
              onToggleFolder={(p) =>
                setCollapsed((m) => {
                  const n = new Set(m);
                  if (n.has(p)) n.delete(p);
                  else n.add(p);
                  return n;
                })
              }
              sel={sel}
              onToggleFile={toggleFile}
              onToggleFolderSel={toggleFolderSel}
              renaming={renaming}
              renameTo={renameTo}
              onRenameTo={setRenameTo}
              onRequestRename={(p) => {
                setRenaming(p);
                setRenameTo(p);
              }}
              onRenameSubmit={rename}
              onRenameCancel={() => setRenaming(null)}
              onDelete={del}
              busy={busy}
            />
          )}
        </div>
        <div className="mat-syncbar">
          <span className="mat-sync-left">
            <LiveDot tone={online ? "emerald" : "red"} />
            Sync daemon: {daemonLabel}
          </span>
          {lastScanLabel && <span>{lastScanLabel}</span>}
        </div>
      </section>

      {/* ── Ask AI CTA ── */}
      <section className="panel mat-cta">
        <div className="mat-cta-left">
          <span className="icon-tile icon-tile--lg icon-tile--emerald">
            <SparklesIcon className="heroicon" style={{ width: 18, height: 18 }} />
          </span>
          <div>
            <div className="mat-cta-title">Ask AI across {fileCount} Indexed Material{fileCount === 1 ? "" : "s"}</div>
            <div className="mat-cta-sub">Query lecture slides, readings and transcripts with citations.</div>
          </div>
        </div>
        <Link className="btn btn-primary" href={`/course/${encodeURIComponent(slug)}?tab=ask`}>
          <ChatBubbleLeftRightIcon className="heroicon" />
          Launch Ask AI
        </Link>
      </section>
    </div>
  );
}
