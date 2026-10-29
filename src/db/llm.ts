/** Raw LLM provider clients — Gemini `generateContent` and GLM (Zhipu,
 *  OpenAI-compatible) `chat/completions`.
 *
 *  Why it exists (5b-2 c, docs/planning/platform-ai-generation.md blocker #2):
 *  src/pipeline/llm.ts is correct but unbundleable — it imports src/status.ts,
 *  which runs initModelQuotas() and reads settings.json at module load, and the
 *  platform pod only copies src/db/ into the frontend image. This module is the
 *  transport half: global fetch + JSON only, no `pg`, no drizzle, no
 *  src/status.ts, no module-level side effects. Safe to import from a Next
 *  route, and safe to import from the daemon.
 *
 *  Deliberately dumb: one fetch, request shape preserved byte-for-byte from
 *  pipeline/llm.ts (so providers see identical traffic), response body returned
 *  untruncated. NO quota bookkeeping, NO model rotation, NO logging — that
 *  policy stays in src/pipeline/llm.ts for the daemon
 *  (isModelExhausted / recordQuota429 / markModelUnavailable / noteModelUsed)
 *  and belongs to src/db/gen/* for the platform.
 *
 *  Error contract: an HTTP error STATUS never throws — callers branch on
 *  { status, ok } and can inspect `body` (Gemini 429 bodies carry the real RPM/
 *  RPD limits). Network failures and JSON-parse failures do throw, as they do
 *  today. */

// ── Gemini ────────────────────────────────────────────────────────────────

export interface Part { text: string }
export interface MediaPart { inline_data: { mime_type: string; data: string } }
export type AnyPart = Part | MediaPart;

export interface GeminiOpts {
  json?: boolean;
  temperature?: number;
}

/** One provider answer: `text` is the extracted completion ("" on error),
 *  `body` the raw response body (429 limit learning / error messages). */
export interface RawResponse {
  status: number;
  ok: boolean;
  body: string;
  text: string;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Single `:generateContent` round-trip.
 *  Request shape is frozen: the json/temperature spreads both target
 *  `generationConfig`, so passing both yields temperature only (last wins). */
export async function geminiGenerate(
  model: string,
  apiKey: string,
  parts: AnyPart[],
  opts: GeminiOpts = {},
): Promise<RawResponse> {
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      ...(opts.json ? { generationConfig: { responseMimeType: "application/json" } } : {}),
      ...(opts.temperature != null ? { generationConfig: { temperature: opts.temperature } } : {}),
    }),
  });
  const body = await res.text();
  // RESOURCE_EXHAUSTED can ride on a 200 — treat it as the error it is so quota
  // callers see it before any candidate parsing.
  if (!res.ok || body.includes("RESOURCE_EXHAUSTED")) return { status: res.status, ok: false, body, text: "" };
  const json = JSON.parse(body) as any;
  const text = (json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "").trim();
  return { status: res.status, ok: true, body, text };
}

// ── GLM (Zhipu) ───────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Coding Plan keys only authorize /api/coding/paas/v4 (the standard
 *  /api/paas/v4 answers 1113 "insufficient balance" for them). */
export const GLM_DEFAULT_BASE = "https://open.bigmodel.cn/api/coding/paas/v4";

/** Overridable per call — the daemon passes status.ts glmBase()
 *  (settings → GLM_BASE → this default). */
export const glmEndpoint = (base: string = GLM_DEFAULT_BASE): string => `${base}/chat/completions`;

export interface GlmOpts {
  /** endpoint base, e.g. "https://open.bigmodel.cn/api/coding/paas/v4" */
  base?: string;
  temperature?: number;
  /** OpenAI-style function tools; non-empty adds tool_choice: "auto" */
  tools?: unknown[];
}

export interface GlmResponse extends RawResponse { tool_calls?: ToolCall[] }

/** One non-streaming chat-completion round-trip. `temperature` defaults to 0.4
 *  (the chat/raw-call default); glmGenerate pins 0.3 like the text helper. */
export async function glmChatComplete(
  model: string,
  apiKey: string,
  messages: ChatMsg[],
  opts: GlmOpts = {},
): Promise<GlmResponse> {
  const res = await fetch(glmEndpoint(opts.base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
      temperature: opts.temperature ?? 0.4,
    }),
  });
  const body = await res.text();
  if (!res.ok) return { status: res.status, ok: false, body, text: "" };
  const m = (JSON.parse(body) as any)?.choices?.[0]?.message ?? {};
  return {
    status: res.status,
    ok: true,
    body,
    text: (m.content ?? "").trim(),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
  };
}

/** Single-prompt text completion (temperature 0.3 unless overridden). */
export async function glmGenerate(
  model: string,
  apiKey: string,
  prompt: string,
  opts: GlmOpts = {},
): Promise<GlmResponse> {
  return glmChatComplete(model, apiKey, [{ role: "user", content: prompt }], { temperature: 0.3, ...opts });
}

/** Streaming chat completion (SSE). Text deltas are forwarded live via
 *  onDelta; tool-call rounds accumulate silently — the caller only ever sees
 *  finished ToolCall[]s. Falls back to plain JSON parsing when the endpoint
 *  answers without an event-stream.
 *  Unlike the non-streaming calls this THROWS on an error status: there is no
 *  partial answer to inspect, and every caller already treats it as fatal. */
export async function glmStream(
  model: string,
  apiKey: string,
  messages: ChatMsg[],
  tools: unknown[] | undefined,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  base?: string,
): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  const res = await fetch(glmEndpoint(base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, ...(tools?.length ? { tools, tool_choice: "auto" } : {}), temperature: 0.4, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`GLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const json = (await res.json()) as any; // gateway stripped SSE — one-shot
    const m = json?.choices?.[0]?.message ?? {};
    const content = (m.content ?? "").trim();
    if (content) onDelta(content);
    return { content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) };
  }
  let content = "";
  const tcMap = new Map<number, ToolCall>();
  const handle = (payload: string): void => {
    if (!payload || payload === "[DONE]") return;
    let j: any;
    try { j = JSON.parse(payload); } catch { return; }
    const d = j?.choices?.[0]?.delta;
    if (!d) return;
    if (typeof d.content === "string" && d.content) {
      content += d.content;
      onDelta(d.content);
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        const cur = tcMap.get(i) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name = tc.function.name; // name arrives whole, once
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments; // args stream in pieces
        tcMap.set(i, cur);
      }
    }
  };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) handle(line.slice(5).trim());
    }
  }
  if (buf.trim().startsWith("data:")) handle(buf.trim().slice(5).trim());
  const toolCalls = [...tcMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter((t) => t.function.name);
  return { content: content.trim(), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}
