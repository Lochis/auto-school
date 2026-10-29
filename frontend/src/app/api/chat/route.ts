/** Global chat API — proxy to the backend's all-courses /chat endpoint. */
import { NextResponse } from "next/server";
import { daemonUserHeaders, requireUser, unauthorized } from "@/lib/owner";
import { daemonBaseOrThrow } from "@/lib/backend";

export const dynamic = "force-dynamic";

async function proxy(req: Request, method?: string): Promise<Response> {
  if (!(await requireUser())) return unauthorized();
  try {
    const res = await fetch(`${await daemonBaseOrThrow()}/chat`, {
      method: method ?? req.method,
      headers: {
        ...(req.method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(await daemonUserHeaders()),
      },
      body: method === "POST" || (!method && req.method === "POST") ? await req.text() : undefined,
      signal: AbortSignal.timeout(600_000), // tool loop can take minutes
    });
    // POST streams SSE (tool statuses + live answer tokens) — pass through
    if (res.ok && res.body && (method ?? req.method) === "POST") {
      return new Response(res.body, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
      });
    }
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}

export async function GET(req: Request) { return proxy(req); }
export async function POST(req: Request) { return proxy(req); }
export async function DELETE(req: Request) { return proxy(req); }
