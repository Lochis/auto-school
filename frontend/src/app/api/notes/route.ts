/** On-demand notes/transcript markdown for the lazy session panels.
 *  Fs mode reads the files lib/data.ts serves (frontend shares the /data PVC);
 *  DB_READS=1 serves the same markdown from session_artifacts.content. */
import { NextResponse } from "next/server";
import { listCourses, notesMarkdown } from "@/lib/backend";
import { requireUser, unauthorized } from "@/lib/owner";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await requireUser())) return unauthorized();
  const u = new URL(req.url);
  const course = u.searchParams.get("course") ?? "";
  const stem = u.searchParams.get("stem") ?? "";
  const kind = u.searchParams.get("kind") ?? "notes";
  if (!(await listCourses()).includes(course)) return NextResponse.json({ error: "unknown course" }, { status: 404 });
  if (!/^[\w\-.\s:]+$/.test(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  if (!["notes", "running", "transcript"].includes(kind)) return NextResponse.json({ error: "bad kind" }, { status: 400 });

  const markdown = await notesMarkdown(course, stem, kind as "notes" | "running" | "transcript");
  if (markdown === null) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ markdown });
}
