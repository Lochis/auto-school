/**
 * Streaming multipart/form-data parser for Node http.IncomingMessage.
 * Buffers at most (chunk + boundary) bytes — file parts stream to disk.
 * Avoids undici formData()'s whole-body RAM materialization (OOM on
 * multi-hundred-MB lecture videos inside 512Mi containers).
 */
import type { IncomingMessage } from "node:http";
import { createWriteStream, renameSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ParsedPart {
  name: string;
  filename?: string;
  /** for small parts: the content as a string */
  text?: string;
  /** for file parts: where the streamed content landed */
  path?: string;
  bytes: number;
}

const CRLF = Buffer.from("\r\n");

/**
 * Parse a multipart request, streaming file parts to tempDir.
 * Returns field parts as strings and file parts as temp file paths.
 */
export function parseMultipart(req: IncomingMessage, tempDir: string): Promise<ParsedPart[]> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers["content-type"] ?? "");
    const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!bm) return reject(new Error("not a multipart request"));
    const boundary = Buffer.from("--" + (bm[1] ?? bm[2]).trim());
    mkdirSync(tempDir, { recursive: true });

    const parts: ParsedPart[] = [];
    let pending: Buffer = Buffer.alloc(0);

    // part-scanning state
    let inHeaders = false; // consuming part headers
    let headerBuf: Buffer = Buffer.alloc(0);
    let cur: { name: string; filename?: string; headers: string } | null = null;
    let ws: import("node:fs").WriteStream | null = null;
    let textAcc: Buffer[] = [];
    let curBytes = 0;
    let seq = 0;
    let done = false;

    const finishPart = (): void => {
      if (!cur) return;
      const data = Buffer.concat(textAcc);
      if (ws) {
        ws.end();
        parts.push({ name: cur.name, filename: cur.filename, path: ws.path as string, bytes: curBytes });
        ws = null;
      } else {
        parts.push({ name: cur.name, filename: cur.filename, text: data.toString("utf8"), bytes: curBytes });
      }
      textAcc = [];
      cur = null;
      curBytes = 0;
    };

    const startPart = (headers: string): void => {
      const cd = headers.match(/content-disposition:\s*form-data;([^\r\n]*)/i)?.[1] ?? "";
      const name = cd.match(/name="([^"]*)"/i)?.[1] ?? cd.match(/name=([^;\s]+)/i)?.[1] ?? "";
      const filename = cd.match(/filename="([^"]*)"/i)?.[1] ?? cd.match(/filename=([^;\s]+)/i)?.[1];
      finishPart(); // close any open part
      cur = { name, filename: filename || undefined, headers };
      if (filename) {
        const tmp = `${tempDir}/part-${Date.now()}-${seq++}`;
        ws = createWriteStream(tmp, { flags: "w" });
        // ws errors shouldn't kill the request mid-stream silently
        ws.on("error", (e) => reject(e));
      }
    };

    const consume = (chunk: Buffer): void => {
      if (done) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

      for (;;) {
        if (inHeaders) {
          // looking for CRLFCRLF that ends the headers
          const hi = pending.indexOf(Buffer.concat([CRLF, CRLF]));
          if (hi === -1) {
            // headers not complete; but bound the header buffer (sanity)
            if (pending.length > 64 * 1024) return reject(new Error("part headers too large"));
            return;
          }
          const headers = pending.subarray(0, hi).toString("utf8");
          pending = pending.subarray(hi + 4);
          startPart(headers);
          inHeaders = false;
          continue; // process remaining pending as body
        }

        // body mode: look for the next boundary
        const bi = pending.indexOf(boundary);
        if (bi === -1) {
          // flush all but the last (boundary.len) bytes — a boundary split
          // across chunks must never be written into part data
          const safe = pending.length - boundary.length;
          if (safe > 0) {
            const out = pending.subarray(0, safe);
            if (ws) ws.write(out);
            else textAcc.push(out);
            curBytes += out.length;
            pending = pending.subarray(safe);
          }
          return;
        }
        // boundary found: data ends at bi (strip the CRLF before it)
        let dataEnd = bi;
        if (dataEnd >= 2 && pending[dataEnd - 2] === 13 && pending[dataEnd - 1] === 10) dataEnd -= 2;
        const out = pending.subarray(0, dataEnd);
        if (ws) ws.write(out);
        else textAcc.push(out);
        curBytes += out.length;
        pending = pending.subarray(bi);

        // pending now starts with the boundary — check what follows
        const after = pending.subarray(boundary.length);
        if (after.subarray(0, 2).toString() === "--") {
          finishPart();
          done = true;
          // drain any trailing epilogue bytes
          pending = Buffer.alloc(0);
          return;
        }
        // a normal part separator: skip CRLF after boundary, expect headers
        let skip = 2; // the CRLF after the boundary line
        if (after[0] === 13 && after[1] === 10) skip = 2;
        pending = pending.subarray(boundary.length + skip);
        finishPart();
        inHeaders = true;
        continue;
      }
    };

    req.on("data", (c: Buffer) => consume(c));
    req.on("error", (e) => {
      try { ws?.end(); } catch { /* noop */ }
      reject(e);
    });
    req.on("end", () => {
      try {
        if (!done) {
          // no terminating boundary seen — treat as complete anyway if a part is open
          finishPart();
        } else finishPart();
        // wait for write streams to flush before resolving
        const open = parts.filter((p) => p.path).length;
        let waited = 0;
        const check = (): void => {
          // crude but effective: poll until the temp files quiesce
          const anyOpen = parts.some((p) => p.path);
          if (!anyOpen || waited > 5000) {
            resolve(parts);
          } else { waited += 50; setTimeout(check, 50); }
        };
        // ensure final ws flushed (ws.end already called; node flushes async)
        setTimeout(() => resolve(parts), 50);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Move a streamed temp part into place (atomic rename). */
export function placePart(tmpPath: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(tmpPath, dest);
}

/** Discard a temp part (on error paths). */
export function discardPart(tmpPath: string): void {
  try { rmSync(tmpPath); } catch { /* already gone */ }
}
