import { readCalendar } from "@/lib/calendar";
import ScheduleScreen from "@/components/schedule/schedule-screen";

export const dynamic = "force-dynamic";

/** Root dashboard (app "/"): server side only reads the backend's last
 *  calendar scan (out/calendar-events.txt) — every live join-state badge,
 *  the daemon bar and the activity stream poll /api/backend client-side. */
export default function CalendarBoard() {
  const { events, asOf } = readCalendar();
  // serialize dates for the client boundary
  const plain = events.map((e) => ({ ...e, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() }));
  return <ScheduleScreen events={plain} asOf={asOf ? asOf.toISOString() : null} />;
}
