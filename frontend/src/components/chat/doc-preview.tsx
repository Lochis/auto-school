"use client";
/** Inline material previewer overlay (moved from chat-tab.tsx — unchanged
 *  behavior): click-outside to close; PDFs/images render natively, docx
 *  prefers the proactive .index PDF twin, everything else extracts text. */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUpRightIcon, XMarkIcon } from "@heroicons/react/24/outline";

export default function DocPreview({ slug, path, onClose }: { slug: string; path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [twin, setTwin] = useState<string | null>(null); // docx→pdf twin, if converted
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const media = `/api/media/courses/${encodeURIComponent(slug)}/materials/${path.split("/").map(encodeURIComponent).join("/")}`;
  // bundle twin: .index/<rel-minus-ext>/source.pdf (proactive docx→pdf pass)
  const twinUrl = ext === "docx"
    ? `/api/media/courses/${encodeURIComponent(slug)}/materials/.index/${path.replace(/\.docx$/i, "").split("/").map(encodeURIComponent).join("/")}/source.pdf`
    : null;

  useEffect(() => {
    let alive = true;
    if (ext === "pdf" || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return; // rendered natively
    if (ext === "docx" && twinUrl) {
      // prefer the PDF twin for viewing; fall back to text if not converted yet
      fetch(twinUrl, { method: "HEAD" })
        .then((r) => {
          if (!alive) return;
          if (r.ok) { setTwin(twinUrl); return; }
          setTwin("none");
          return fetch(`/api/courses/${encodeURIComponent(slug)}/doc?path=${encodeURIComponent(path)}`)
            .then((r2) => r2.json())
            .then((j) => { if (alive) setText(j.error ? `error: ${j.error}` : (j.text || "(empty)")); });
        })
        .catch(() => {
          if (!alive) return;
          setTwin("none");
          fetch(`/api/courses/${encodeURIComponent(slug)}/doc?path=${encodeURIComponent(path)}`)
            .then((r2) => r2.json())
            .then((j) => { if (alive) setText(j.error ? `error: ${j.error}` : (j.text || "(empty)")); })
            .catch(() => { if (alive) setText("preview unavailable"); });
        });
      return;
    }
    fetch(`/api/courses/${encodeURIComponent(slug)}/doc?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((j) => { if (alive) setText(j.error ? `error: ${j.error}` : (j.text || "(empty)")); })
      .catch(() => { if (alive) setText("preview unavailable"); });
    return () => { alive = false; };
  }, [slug, path, ext, twinUrl]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(900px, 94vw)", height: "86vh", display: "flex", flexDirection: "column", padding: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path}</strong>
          <span style={{ flex: 1 }} />
          <a href={media} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>open raw <ArrowUpRightIcon className="heroicon" style={{ display: "inline" }} /></a>
          <button onClick={onClose}><XMarkIcon className="heroicon" style={{ display: "inline" }} /> close</button>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {ext === "pdf" || twin?.startsWith("/") ? (
            <iframe src={twin?.startsWith("/") ? twin : media} title={path} style={{ width: "100%", height: "100%", border: 0, background: "#fff", borderRadius: 8 }} />
          ) : ["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media} alt={path} style={{ maxWidth: "100%", display: "block", margin: "0 auto" }} />
          ) : (
            <div className="notes" style={{ fontSize: 14 }}>
              {ext === "docx" && twin === null ? <p className="muted">checking for PDF twin…</p> : null}
              {text === null && !(ext === "docx" && twin === null) ? <p className="muted">extracting text…</p> : null}
              {text !== null ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
