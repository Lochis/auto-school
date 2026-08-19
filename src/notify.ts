import { writeFileSync } from "node:fs";

/** Discord webhook helpers with optional file attachment (screenshot). */

export async function notify(content: string, screenshot?: Buffer): Promise<void> {
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
      form.append("files[0]", new Blob([screenshot], { type: "image/png" }), "screenshot.png");
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
