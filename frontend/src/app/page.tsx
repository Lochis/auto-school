import BackendBar from "./backend-bar";
import CalendarBoard from "./calendar-board";

export const dynamic = "force-dynamic"; // data changes as the backend records

export default function Home() {
  return (
    <main>
      <h1>Schedule</h1>
      <BackendBar />
      <CalendarBoard />
    </main>
  );
}
