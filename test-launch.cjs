// Isolation test: Playwright under plain Node (no Bun, no Teams).
// Expect: prints "LAUNCHED OK" then closes. Run: node test-launch.cjs
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: false });
  console.log("LAUNCHED OK");
  const p = await b.newPage();
  await p.goto("https://example.com", { timeout: 30_000 });
  console.log("NAV OK:", p.url());
  await b.close();
  console.log("CLOSED OK");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
