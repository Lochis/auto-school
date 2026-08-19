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
    // Pre-grant mic/cam so the NATIVE browser permission prompt never blocks the
    // meeting tab (that prompt is not page DOM — it can't be clicked via selectors)
    await r.ctx.grantPermissions(["microphone", "camera"]).catch(() => {});
    const { listMeetings } = await import("./meetings/list.ts");
    const meetings = await listMeetings(r.page);
    const { joinMeeting } = await import("./meetings/join.ts");
    const live = meetings.filter((m) => m.joinableNow);
    if (flags.has("--join") && live.length) {
      console.log(`[auto-school] --join: joining first live meeting (${live[0].title})`);
      const page = await joinMeeting(r.ctx!, live[0]);
      if (page) {
        const { startRecording, stopRecording, stillInMeeting } = await import("./record/recorder.ts");
        let rec: Awaited<ReturnType<typeof startRecording>> | null = null;
        if (flags.has("--record")) {
          try {
            rec = await startRecording(page, live[0].title);
          } catch (e) {
            console.error(`[rec] ! ${e}`);
            await (await import("./notify.ts")).notify(`⚠️ Recording failed to start: \`${String(e).slice(0, 150)}\``);
          }
        }
        console.log(`[join] in-meeting${rec ? ", recording" : ""}; holding — Ctrl+C to leave`);
        // monitor: stop recording when the call ends (marker gone >30s)
        if (rec) {
          let misses = 0;
          while (misses < 30) {
            await new Promise((res) => setTimeout(res, 2_000));
            if (await stillInMeeting(page)) misses = 0;
            else misses++;
          }
          const done = await stopRecording(page);
          const { notify } = await import("./notify.ts");
          if (done) {
            console.log(`[rec] stopped: ${done.segments.length} segment(s), ${(done.bytes / 1e6).toFixed(1)} MB, ${Math.round(done.ms / 60000)} min -> ${"segments/"}`);
            await notify(`⏹️ Recording ended: ${done.segments.length} segment(s), ${(done.bytes / 1e6).toFixed(0)} MB, ${Math.round(done.ms / 60000)} min`);
          }
        } else {
          await new Promise(() => {});
        }
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
