/** Stream media files (mp4/webm/wav) — recorder-split.md §5 step 3 flip:
 *  when the owner has a fresh recorder with the mediaServe capability, proxy
 *  the stream from that recorder's endpoint; otherwise fall back to the
 *  mounted /data dir (same-pod transitional phase — still mounted this
 *  phase). HTTP Range support is preserved for <audio>/<video> seeking. */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { DATA_DIR } from "@/lib/data";
import { ownerId } from "@/lib/owner";
import { getActiveRecorder } from "../../../../../../src/db/recorders.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Proxy the stream from the recorder endpoint (no buffering). Forwards
 *  status + content-type/length/range so seeking keeps working. Unreachable
 *  recorder → clean 404; mid-stream failures terminate the pass-through body. */
async function proxyRecorderMedia(endpoint: string, req: Request, path: string[]): Promise<Response | null> {
  const url = `${endpoint.replace(/\/+$/, "")}/${path.map(encodeURIComponent).join("/")}`;
  const range = req.headers.get("range");
  try {
    const upstream = await fetch(url, {
      headers: range ? { Range: range } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok || !upstream.body) return null;
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
    };
    const ct = upstream.headers.get("content-type");
    if (ct) headers["Content-Type"] = ct;
    const cl = upstream.headers.get("content-length");
    if (cl) headers["Content-Length"] = cl;
    const cr = upstream.headers.get("content-range");
    if (cr) headers["Content-Range"] = cr;
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return null; // recorder unreachable — fall through to fs
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const rel = normalize(path.join("/"));

  // recorder-proxy flip: only when this owner has a fresh mediaServe recorder
  const owner = await ownerId();
  if (owner) {
    try {
      const rec = await getActiveRecorder(owner);
      if (rec?.endpoint && rec.capabilities?.mediaServe === true) {
        const proxied = await proxyRecorderMedia(rec.endpoint, req, path);
        if (proxied) return proxied;
      }
    } catch {
      // DB down — fall through to the mounted fs (transitional)
    }
  }

  const file = join(DATA_DIR, rel);
  // traversal guard: resolved path must stay under DATA_DIR
  if (rel.startsWith("..") || !file.startsWith(DATA_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return new Response("not found", { status: 404 });
  }

  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range");

  if (range) {
    const m = /bytes=(\d+)?-(\d+)?/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      const stream = createReadStream(file, { start, end });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }
  }

  return new Response(Readable.toWeb(createReadStream(file)) as unknown as ReadableStream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
    },
  });
}
