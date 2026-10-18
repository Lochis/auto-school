/** Discord webhook helpers with optional file attachment (screenshot).
 *  All sends go through a FIFO queue with a ~700ms floor between posts
 *  (Discord rate limit ≈5 req/2s per webhook) and a drop-oldest cap so a
 *  tight poll loop can never flood the webhook. */

const MIN_GAP_MS = 700;
const MAX_PENDING = 10;

let queue: Array<() => Promise<void>> = [];
let draining = false;

function drain(): void {
  if (draining) return;
  draining = true;
  void (async () => {
    while (queue.length) {
      const job = queue.shift()!;
      try { await job(); } catch { /* jobs never reject (inner try/catch) */ }
      await new Promise((r) => setTimeout(r, MIN_GAP_MS));
    }
    draining = false;
  })();
}

function enqueue(job: () => Promise<void>): void {
  if (queue.length >= MAX_PENDING) queue.shift(); // drop-oldest under flood
  queue.push(job);
  drain();
}

async function send(content: string, screenshot?: Buffer): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn(`[notify] (no webhook configured) ${content}`);
    return;
  }
  try {
    if (screenshot?.length) {
      // multipart upload: raw PNG buffer + message json
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ username: "auto-school", content }));
      form.append("files[0]", new Blob([new Uint8Array(screenshot)], { type: "image/png" }), "screenshot.png");
      const res = await fetch(url, { method: "POST", body: form });
      if (!res.ok) console.warn(`[notify] webhook returned ${res.status}`);
      return;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "auto-school",
        content: `${content} — <t:${Math.floor(Date.now() / 1000)}:R>`,
      }),
    });
    if (!res.ok) console.warn(`[notify] webhook returned ${res.status}`);
  } catch (err) {
    console.warn(`[notify] webhook failed:`, err);
  }
}

export async function notify(content: string, screenshot?: Buffer): Promise<void> {
  enqueue(() => send(content, screenshot));
}
