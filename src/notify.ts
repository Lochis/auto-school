/** Discord webhook helpers with optional file attachment (screenshot). */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export async function notify(content: string, screenshotPath?: string): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn(`[notify] (no webhook configured) ${content}`);
    return;
  }
  try {
    if (screenshotPath) {
      // multipart upload: file + message json
      const blob = new Blob([readFileSync(screenshotPath)], { type: "image/png" });
      const form = new FormData();
      form.append("payload_json", JSON.stringify({
        username: "auto-school",
        content,
      }));
      form.append("files[0]", blob, basename(screenshotPath));
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
