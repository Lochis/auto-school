/** Global chat API — proxy to the backend's all-courses /chat endpoint. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const BASE = process.env.BACKEND_URL ?? "http://127.0.0.1:7800";

async function proxy(req: Request, method?: string): Promise<Response> {
  try {
    const res = await fetch(`${BASE}/chat`, {
      method: method ?? req.method,
      headers: req.method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" || (!method && req.method === "POST") ? await req.text() : undefined,
      signal: AbortSignal.timeout(600_000), // tool loop can take minutes
    });
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}

export async function GET(req: Request) { return proxy(req); }
export async function POST(req: Request) { return proxy(req); }
export async function DELETE(req: Request) { return proxy(req); }
