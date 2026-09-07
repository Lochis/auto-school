import { readCalendar } from "@/lib/calendar";
import CalendarList from "./calendar-list";

export const dynamic = "force-dynamic";

/** Today's calendar from the backend's last scan (out/calendar-events.txt).
 *  Live join-state + Leave button live in the client component. */
export default function CalendarBoard() {
  const { events, asOf } = readCalendar();
  // serialize dates for the client boundary
  const plain = events.map((e) => ({ ...e, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() }));
  return <CalendarList events={plain} asOf={asOf ? asOf.toISOString() : null} />;
}
