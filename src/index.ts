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
  default:
    console.log(`usage: node src/index.ts login [--fresh] [--hold]`);
    process.exit(1);
}
