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

try { process.loadEnvFile(); } catch { /* .env optional if env vars come from elsewhere */ }

function geminiModels(): string[] {
  return modelChain(); // live: settings.json wins, .env is the seed
}

interface Part { text: string; }
interface MediaPart { inline_data: { mime_type: string; data: string } }
type AnyPart = Part | MediaPart;

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
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            ...(opts.json ? { generationConfig: { responseMimeType: "application/json" } } : {}),
            ...(opts.temperature != null ? { generationConfig: { temperature: opts.temperature } } : {}),
          }),
        },
      );
      const body = await res.text();
      if (res.status === 429 || body.includes("RESOURCE_EXHAUSTED")) {
        recordQuota429(model, body); // detects limits + schedules recovery + logs activity
        continue;
      }
      if (res.status === 404 || res.status === 403) {
        markModelUnavailable(model, res.status); // e.g. gemini-2.5-flash is gone for new keys
        continue;
      }
      if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${body.slice(0, 200)}`);
      const json = JSON.parse(body) as any;
      noteModelUsed(model);
      return (json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "").trim();
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`all Gemini models failed — last: ${lastErr}`);
}

/** GLM endpoint — Coding Plan keys only authorize /api/coding/paas/v4 (the
 *  standard /api/paas/v4 returns 1113 "insufficient balance" for them).
 *  Overridable via GLM_BASE. */
const glmEndpoint = (): string => `${glmBase()}/chat/completions`;

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

/** One raw round-trip with optional OpenAI-style tools — returns the assistant
 *  message (content and/or tool_calls) so the caller drives the tool loop. */
export async function glmChatRaw(
  messages: ChatMsg[],
  tools?: unknown[],
): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  const key = apiKey("GLM_API_KEY");
  if (!key) throw new Error("GLM_API_KEY not set");
  const model = process.env.GLM_MODEL ?? "glm-5.3";
  const res = await fetch(glmEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, ...(tools?.length ? { tools, tool_choice: "auto" } : {}), temperature: 0.4 }),
  });
  if (!res.ok) throw new Error(`GLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as any;
  const m = json?.choices?.[0]?.message ?? {};
  return { content: (m.content ?? "").trim(), ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) };
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
  const model = process.env.GLM_MODEL ?? "glm-5.3";
  const res = await fetch(glmEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`GLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as any;
  return (json?.choices?.[0]?.message?.content ?? "").trim();
}

/** Multi-turn chat via GLM (Zhipu) — system prompt + message history. */
export async function glmChat(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const key = apiKey("GLM_API_KEY");
  if (!key) throw new Error("GLM_API_KEY not set");
  const model = process.env.GLM_MODEL ?? "glm-5.3";
  const res = await fetch(glmEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`GLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as any;
  return (json?.choices?.[0]?.message?.content ?? "").trim();
}

/** Text work: GLM if configured, else the Gemini chain. */
export async function textCall(prompt: string): Promise<string> {
  if (apiKey("GLM_API_KEY")) {
    try { return await glmCall(prompt); }
    catch (e) { console.warn(`[llm] GLM failed (${String(e).slice(0, 120)}) → Gemini`); }
  }
  return geminiCall([{ text: prompt }], { temperature: 0.3 });
}
