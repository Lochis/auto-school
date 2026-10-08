"use client";
/**
 * Hierarchical materials explorer table — folder tree with expand chevrons,
 * indent levels, per-row checkboxes, extension-derived category tags,
 * tabular sizes (cyan emphasis >10 MB) and per-row download / rename /
 * delete actions. Root-level files render under a "Loose / Root Resources"
 * divider.
 */
import {
  ArrowDownTrayIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  PencilIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { filesUnder, fmtSize, kindFor, sortNodes, type Entry, type TNode } from "./file-meta";

export interface FileTreeProps {
  root: TNode;
  slug: string;
  /** folder paths that are collapsed (absent = expanded) */
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  sel: Set<string>;
  onToggleFile: (path: string) => void;
  /** select/deselect the whole folder (paths of every contained file) */
  onToggleFolderSel: (paths: string[]) => void;
  renaming: string | null;
  renameTo: string;
  onRenameTo: (v: string) => void;
  onRequestRename: (path: string) => void;
  onRenameSubmit: (from: string) => void;
  onRenameCancel: () => void;
  onDelete: (path: string) => void;
  busy: boolean;
}

export default function FileTree(props: FileTreeProps) {
  const { root, slug, sel, collapsed } = props;
  const dl = (p: string): string =>
    `/api/courses/${encodeURIComponent(slug)}/materials/download?p=${encodeURIComponent(p)}`;

  function RenameEditor({ from }: { from: string }) {
    return (
      <span className="mat-rename" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={props.renameTo}
          onChange={(e) => props.onRenameTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onRenameSubmit(from);
            if (e.key === "Escape") props.onRenameCancel();
          }}
          aria-label={`rename ${from}`}
        />
        <button type="button" className="btn btn-micro btn-primary" disabled={props.busy} onClick={() => props.onRenameSubmit(from)}>
          Save
        </button>
        <button type="button" className="btn btn-micro" onClick={props.onRenameCancel}>
          Cancel
        </button>
      </span>
    );
  }

  function FileRow({ f, depth }: { f: Entry; depth: number }) {
    const kind = kindFor(f.filename);
    return (
      <div className="mat-row mat-row--file">
        <div className="mat-name" style={{ paddingLeft: depth * 18 }}>
          <input
            type="checkbox"
            className="selbox"
            checked={sel.has(f.path)}
            onChange={() => props.onToggleFile(f.path)}
            aria-label={`select ${f.filename}`}
          />
          <kind.Icon className={`heroicon ${kind.iconClass}`} />
          {props.renaming === f.path ? (
            <RenameEditor from={f.path} />
          ) : (
            <span className="mat-fname mat-fname--file" title={f.path}>
              {f.filename}
            </span>
          )}
        </div>
        <span className={`mat-col mat-col--size${f.size > 10 * 1024 * 1024 ? " mat-size--big" : ""}`}>{fmtSize(f.size)}</span>
        <span className="mat-col mat-col--act">
          <a className="iconbtn mat-act" href={dl(f.path)} title="Download this file">
            <ArrowDownTrayIcon className="heroicon" />
          </a>
          <button type="button" className="iconbtn mat-act" title="Rename / move" onClick={() => props.onRequestRename(f.path)}>
            <PencilIcon className="heroicon" />
          </button>
          <button type="button" className="iconbtn mat-act mat-act--del" title="Delete" onClick={() => props.onDelete(f.path)}>
            <XMarkIcon className="heroicon" />
          </button>
        </span>
      </div>
    );
  }

  function FolderRow({ n, depth }: { n: TNode; depth: number }) {
    const files = filesUnder(n);
    const paths = files.map((f) => f.path);
    const picked = paths.filter((p) => sel.has(p)).length;
    const state = picked === 0 ? "none" : picked === paths.length ? "all" : "some";
    const open = !collapsed.has(n.path);
    const total = files.reduce((s, f) => s + f.size, 0);
    const nested = [...n.children.values()].filter((c) => !c.file).length;
    return (
      <>
        <div className="mat-row mat-row--folder">
          <div className="mat-name" style={{ paddingLeft: depth * 18 }}>
            <input
              type="checkbox"
              className="selbox"
              checked={state === "all"}
              ref={(el) => {
                if (el) el.indeterminate = state === "some";
              }}
              onChange={() => props.onToggleFolderSel(paths)}
              aria-label={`select folder ${n.name}`}
            />
            <button
              type="button"
              className={`mat-caret${open ? " mat-caret--open" : ""}`}
              onClick={() => props.onToggleFolder(n.path)}
              aria-label={`${open ? "collapse" : "expand"} ${n.name}`}
              aria-expanded={open}
            >
              <ChevronRightIcon className="heroicon" />
            </button>
            <span className={`icon-tile mat-ftile${open ? " icon-tile--emerald" : ""}`}>
              {open ? <FolderOpenIcon className="heroicon" /> : <FolderIcon className="heroicon" />}
            </span>
            {props.renaming === n.path ? (
              <RenameEditor from={n.path} />
            ) : (
              <>
                <span className="mat-fname" title={n.path}>
                  {n.name}
                </span>
                {n.name === ".index" ? (
                  <span className="chip chip--neutral">hidden / cache</span>
                ) : (
                  <span className="chip">
                    {nested > 0 ? `${nested} nested folder · ` : ""}
                    {files.length} item{files.length === 1 ? "" : "s"}
                  </span>
                )}
              </>
            )}
          </div>
          <span className="mat-col mat-col--cat" />
          <span className="mat-col mat-col--size mat-col--size-muted" title="total size of contained files">
            {fmtSize(total)}
          </span>
          <span className="mat-col mat-col--act">
            <a className="iconbtn mat-act" href={dl(n.path)} title="Download folder (zip)">
              <ArrowDownTrayIcon className="heroicon" />
            </a>
            <button type="button" className="iconbtn mat-act" title="Rename folder" onClick={() => props.onRequestRename(n.path)}>
              <PencilIcon className="heroicon" />
            </button>
            <button
              type="button"
              className="iconbtn mat-act mat-act--del"
              title={`Delete folder${files.length ? ` (${files.length} files)` : ""}`}
              onClick={() => props.onDelete(n.path)}
            >
              <XMarkIcon className="heroicon" />
            </button>
          </span>
        </div>
        {open &&
          sortNodes(n.children.values()).map((c) =>
            c.file ? <FileRow key={c.path} f={c.file} depth={depth + 1} /> : <FolderRow key={c.path} n={c} depth={depth + 1} />,
          )}
      </>
    );
  }

  const kids = sortNodes(root.children.values());
  const folders = kids.filter((c) => !c.file);
  const loose = kids.filter((c): c is TNode & { file: Entry } => Boolean(c.file));

  return (
    <div>
      {folders.map((c) => (
        <FolderRow key={c.path} n={c} depth={0} />
      ))}
      {loose.length > 0 && folders.length > 0 && <div className="mat-loose-head">Loose / Root Resources</div>}
      {loose.map((c) => (
        <FileRow key={c.path} f={c.file} depth={0} />
      ))}
    </div>
  );
}
