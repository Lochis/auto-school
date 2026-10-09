"use client";
/** Schedule & automation dashboard orchestrator (stitch screen 5):
 *  daemon hero bar → (Completed Sessions | Automation Directives) +
 *  Activity Stream → Calendar panel. Server data (calendar scan dump)
 *  arrives as props; every live badge polls /api/backend client-side. */
import "../../app/schedule-ui.css";
import type { CalEvent } from "@/lib/calendar-shared";
import DaemonBar from "./daemon-bar";
import CompletedSessions from "./completed-sessions";
import ActivityStream from "./activity-stream";
import AutomationDirectives from "./automation-directives";
import CalendarList from "../../app/calendar-list";

export default function ScheduleScreen({ events, asOf }: { events: CalEvent[]; asOf: string | null }) {
  return (
    <div className="sched-page">
      <DaemonBar events={events} />
      <div className="sched-grid">
        <div className="sched-col-left">
          <CompletedSessions />
          <AutomationDirectives />
        </div>
        <ActivityStream />
      </div>
      <CalendarList events={events} asOf={asOf} />
    </div>
  );
}
