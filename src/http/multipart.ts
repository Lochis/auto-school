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
    let settled = false;

    // write streams still flushing to disk — the promise may only resolve
    // once every temp file has quiesced, otherwise the caller renames a
    // HALF-WRITTEN file into recordings/ (truncated video, no error)
    const openStreams = new Set<import("node:fs").WriteStream>();
    let reqEnded = false;
    const FLUSH_TIMEOUT = 60_000; // a stalled disk must not hang the request forever
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (flushTimer) clearTimeout(flushTimer);
      resolve(parts);
    };
    const maybeSettle = (): void => {
      if (reqEnded && openStreams.size === 0) settle();
    };

    /** clean up every temp file, then reject — failure paths must not leak
     *  half-written parts onto the volume */
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      if (flushTimer) clearTimeout(flushTimer);
      const streams = new Set(openStreams);
      if (ws) streams.add(ws); // current part isn't in openStreams-based `parts` yet
      for (const s of streams) {
        try { s.destroy(); } catch { /* noop */ }
        // the create-open() may still be in flight and re-create the file
        // after the immediate rmSync — remove again once the fd is closed
        s.once("close", () => { try { rmSync(String(s.path)); } catch { /* already gone */ } });
      }
      for (const p of parts) if (p.path) { try { rmSync(p.path); } catch { /* already gone */ } }
      reject(e instanceof Error ? e : new Error(String(e)));
    };

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
        const s = createWriteStream(tmp, { flags: "w" });
        openStreams.add(s);
        // "close" = fully flushed + fd released → safe to rename; it also
        // resumes a paused request stream if the part ended mid-backpressure
        s.on("close", () => {
          openStreams.delete(s);
          req.resume();
          maybeSettle();
        });
        s.on("drain", () => req.resume()); // backpressure release — without this a large upload deadlocks
        s.on("error", (e) => fail(e));
        ws = s;
      }
    };

    /** backpressure: without this the write stream queues the WHOLE video in
     *  RAM (undici keeps delivering) — a 600MB upload pushed the daemon to
     *  1.7GB RSS; GB-scale lectures OOM the pod */
    const writeData = (out: Buffer): void => {
      if (ws) {
        if (!ws.write(out)) req.pause(); // "drain"/"close" resumes
      } else textAcc.push(out);
      curBytes += out.length;
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
            if (pending.length > 64 * 1024) return fail(new Error("part headers too large"));
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
            writeData(pending.subarray(0, safe));
            pending = pending.subarray(safe);
          }
          return;
        }
        // boundary found: data ends at bi (strip the CRLF before it)
        let dataEnd = bi;
        if (dataEnd >= 2 && pending[dataEnd - 2] === 13 && pending[dataEnd - 1] === 10) dataEnd -= 2;
        writeData(pending.subarray(0, dataEnd));
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
    req.on("error", (e) => fail(e));
    req.on("end", () => {
      try {
        // no terminating boundary seen → truncated upload: fail loudly
        // (the middleware body cap truncated videos at exactly this point)
        if (!done) {
          return fail(new Error("truncated multipart body — no closing boundary"));
        }
        finishPart();
        reqEnded = true;
        // resolve only once every temp file is flushed; bounded by a timer so
        // a stalled disk can't hang the caller forever
        flushTimer = setTimeout(settle, FLUSH_TIMEOUT);
        maybeSettle();
      } catch (e) {
        fail(e);
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
