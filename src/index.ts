import { loginTeams } from "./login/teams-login.ts";

const cmd = process.argv[2] ?? "login";
const flags = new Set(process.argv.slice(3));

switch (cmd) {
  case "login":
    console.log("[auto-school] starting Teams login prototype");
    (await loginTeams({ fresh: flags.has("--fresh"), hold: flags.has("--hold") })).ok
      ? process.exit(0)
      : process.exit(1);
    break;
  case "meetings": {
    console.log("[auto-school] listing today's meetings via Graph API");
    const { listTodayMeetings } = await import("./graph/meetings.ts");
    const meetings = await listTodayMeetings();
    console.log(`[meetings] ${meetings.length} today:`);
    for (const m of meetings) {
      const t = m.start ? new Date(m.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?";
      console.log(`  • ${t}  ${m.subject.slice(0, 70)}${m.joinUrl ? "  [joinable]" : "  (no join link)"}`);
    }
    const joinable = meetings.filter((m) => m.joinUrl);
    if (joinable.length) {
      console.log("\n[join] next joinable:");
      const now = Date.now();
      const next = joinable
        .filter((m) => new Date(m.end).getTime() > now)
        .sort((a, b) => +new Date(a.start) - +new Date(b.start))[0];
      if (next) console.log(`  → ${next.subject} @ ${new Date(next.start).toLocaleTimeString()}\n    ${next.joinUrl}`);
    }
    break;
  }
  default:
    console.log(`usage: node src/index.ts login [--fresh] [--hold]\n       node src/index.ts meetings`);
    process.exit(1);
}
