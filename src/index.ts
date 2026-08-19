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
    console.log("[auto-school] listing today's meetings (browser session)");
    const r = await loginTeams({ keepOpen: true });
    if (!r.ok || !r.page || !r.ctx) process.exit(1);
    const { listMeetings } = await import("./meetings/list.ts");
    const meetings = await listMeetings(r.page);
    const { joinMeeting } = await import("./meetings/join.ts");
    const live = meetings.filter((m) => m.joinableNow);
    if (flags.has("--join") && live.length) {
      console.log(`[auto-school] --join: joining first live meeting (${live[0].title})`);
      const page = await joinMeeting(r.ctx!, live[0]);
      if (page) {
        console.log("[join] in-meeting; holding browser open — Ctrl+C to leave");
        await new Promise(() => {});
      }
    } else if (live.length) {
      console.log("[meetings] live meeting(s) available — re-run with --join to enter");
    }
    await r.ctx!.close();
    break;
  }
  default:
    console.log(`usage: node src/index.ts login [--fresh] [--hold]\n       node src/index.ts meetings`);
    process.exit(1);
}
