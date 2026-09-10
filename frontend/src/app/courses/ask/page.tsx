import Link from "next/link";
import ChatTab from "../../course/[slug]/chat-tab";

export const dynamic = "force-dynamic";

export default function AskAllPage() {
  return (
    <main>
      <p><Link href="/courses">← Courses</Link></p>
      <h1>Ask — all courses</h1>
      <p className="muted">One assistant across every course: week planning, deadlines, study priorities. It reads each course&apos;s documents and sessions itself.</p>
      <ChatTab />
    </main>
  );
}
