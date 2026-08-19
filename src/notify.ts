/** Discord webhook notifications. No-op (with a warning) if webhook unset. */
export async function notify(content: string): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn(`[notify] (no webhook configured) ${content}`);
    return;
  }
  try {
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
