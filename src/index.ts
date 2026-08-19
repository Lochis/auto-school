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
    console.log("[auto-school] listing today's meetings (logs in first if needed)");
    const r = await loginTeams({ keepOpen: true });
    if (!r.ok || !r.page || !r.ctx) process.exit(1);
    const { listMeetings } = await import("./meetings/list.ts");
    await listMeetings(r.page);
    await r.ctx.close();
    break;
  }
  default:
    console.log(`usage: node src/index.ts login [--fresh] [--hold]\n       node src/index.ts meetings`);
    process.exit(1);
}
