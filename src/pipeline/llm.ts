/**
 * Shared LLM client with quota-aware fallback.
 *
 * Gemini: tries each model in GEMINI_MODELS (quota is per-model, so a chain
 * multiplies the daily budget). 429 -> learn the real limit from the body,
 * cool that model down (retry-after for RPM, PT midnight for RPD) and use the
 * next model. 404/403 -> model dropped for the session. All of it is logged
 * to the activity feed via status.ts.
 * Text work (folds, finalize): GLM via Zhipu if GLM_API_KEY set (saves Gemini
 * quota for video), else Gemini chain.
 */

import { isModelExhausted, isModelAvailable, recordQuota429, markModelUnavailable, noteModelUsed, getModelQuotas, modelChain, apiKey, glmBase } from "../status.ts";
// Transport (one fetch + body parse, no policy) lives in db/llm.ts so the
// platform image — which only copies src/db/ — can reuse it (5b-2 c blocker 2).
// All quota bookkeeping, key resolution and model rotation stays HERE.
import { geminiGenerate, glmChatComplete, glmGenerate, glmStream, type AnyPart, type ChatMsg, type ToolCall } from "../db/llm.ts";
export type { ChatMsg, ToolCall } from "../db/llm.ts";

try { process.loadEnvFile(); } catch { /* .env optional if env vars come from elsewhere */ }

function geminiModels(): string[] {
  return modelChain(); // live: settings.json wins, .env is the seed
}

const glmModel = (): string => process.env.GLM_MODEL ?? "glm-5.3";

function nearestRecoveryMs(): number {
  const now = Date.now();
  const times = getModelQuotas().filter((q) => q.exhausted && q.exhaustedUntil).map((q) => (q.exhaustedUntil as number) - now);
  return times.length ? Math.max(0, Math.min(...times)) : 60_000;
}

export async function geminiCall(
  parts: AnyPart[],
  opts: { json?: boolean; temperature?: number } = {},
): Promise<string> {
  const key = apiKey("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const models = geminiModels().filter((m) => !isModelExhausted(m) && isModelAvailable(m));
  if (!models.length) throw new Error(`all Gemini models cooling down — next recovers in ${Math.ceil(nearestRecoveryMs() / 1000)}s (GEMINI_MODELS)`);

  let lastErr = "";
  for (const model of models) {
    try {
      const r = await geminiGenerate(model, key, parts, opts);
      if (r.status === 429 || r.body.includes("RESOURCE_EXHAUSTED")) {
        recordQuota429(model, r.body); // detects limits + schedules recovery + logs activity
        continue;
      }
      if (r.status === 404 || r.status === 403) {
        markModelUnavailable(model, r.status); // e.g. gemini-2.5-flash is gone for new keys
        continue;
      }
      if (!r.ok) throw new Error(`Gemini ${model} ${r.status}: ${r.body.slice(0, 200)}`);
      noteModelUsed(model);
      return r.text;
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`all Gemini models failed — last: ${lastErr}`);
}

// GLM transport → db/llm.ts (glmGenerate / glmChatComplete / glmStream).
// The endpoint base stays settings-driven here: glmBase() = settings → GLM_BASE
// → Coding Plan default (/api/coding/paas/v4; the standard /api/paas/v4
// answers 1113 "insufficient balance" for Coding Plan keys).

/** Streaming variant of glmChatRaw — same loop-friendly return shape, but
 *  text tokens are forwarded live via onDelta (tool-call rounds accumulate
 *  silently; the caller only ever sees finished ToolCall[]s). Falls back to
 *  plain JSON parsing when the endpoint answers without an event-stream. */
export async function glmChatStream(
  messages: ChatMsg[],
  tools: unknown[] | undefined,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  const key = apiKey("GLM_API_KEY");
  if (!key) throw new Error("GLM_API_KEY not set");
  return glmStream(glmModel(), key, messages, tools, onDelta, signal, glmBase());
}

/** One raw round-trip with optional OpenAI-style tools — returns the assistant
 *  message (content and/or tool_calls) so the caller drives the tool loop. */
export async function glmChatRaw(
  messages: ChatMsg[],
  tools?: unknown[],
): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  const key = apiKey("GLM_API_KEY");
  if (!key) throw new Error("GLM_API_KEY not set");
  const r = await glmChatComplete(glmModel(), key, messages, { base: glmBase(), tools, temperature: 0.4 });
  if (!r.ok) throw new Error(`GLM ${r.status}: ${r.body.slice(0, 200)}`);
  return { content: r.text, ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) };
}

/** Vision describe via the VLM provider (default: opencode-go mimo-v2.5).
 *  opencode gateways REQUIRE x-opencode-session for routing — always send one. */
export async function vlmDescribe(prompt: string, imageBase64: string, mime = "image/png"): Promise<string> {
  const key = process.env.VLM_API_KEY;
  if (!key) throw new Error("VLM_API_KEY not set");
  const base = process.env.VLM_BASE ?? "https://opencode.ai/zen/go/v1";
  const model = process.env.VLM_MODEL ?? "mimo-v2.5";
  const session = process.env.VLM_SESSION ?? "auto-school";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "x-opencode-session": session,
    },
    // reasoning models spend tokens thinking before answering — budget for it
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${imageBase64}` } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`VLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as any;
  return (json?.choices?.[0]?.message?.content ?? "").trim();
}

/** Text completion via GLM (Zhipu, OpenAI-compatible). Throws if no key. */
export async function glmCall(prompt: string): Promise<string> {
  const key = apiKey("GLM_API_KEY");
  if (!key) throw new Error("GLM_API_KEY not set");
  const r = await glmGenerate(glmModel(), key, prompt, { base: glmBase() });
  if (!r.ok) throw new Error(`GLM ${r.status}: ${r.body.slice(0, 200)}`);
  return r.text;
}

/** Multi-turn chat via GLM (Zhipu) — system prompt + message history. */
export async function glmChat(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const key = apiKey("GLM_API_KEY");
  if (!key) throw new Error("GLM_API_KEY not set");
  const r = await glmChatComplete(glmModel(), key, [{ role: "system", content: system }, ...messages], {
    base: glmBase(), temperature: 0.4,
  });
  if (!r.ok) throw new Error(`GLM ${r.status}: ${r.body.slice(0, 200)}`);
  return r.text;
}

/** Text work: GLM if configured, else the Gemini chain. */
export async function textCall(prompt: string): Promise<string> {
  if (apiKey("GLM_API_KEY")) {
    try { return await glmCall(prompt); }
    catch (e) { console.warn(`[llm] GLM failed (${String(e).slice(0, 120)}) → Gemini`); }
  }
  return geminiCall([{ text: prompt }], { temperature: 0.3 });
}
