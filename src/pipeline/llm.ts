/**
 * Shared LLM client with quota-aware fallback.
 *
 * Gemini video analysis: tries each model in GEMINI_MODELS (quota is per-model,
 * so a chain multiplies the daily budget). 429/quota -> next model; exhausted
 * models are remembered for the session.
 * Text work (folds, finalize): GLM via Zhipu if GLM_API_KEY set (saves Gemini
 * quota for video), else Gemini chain.
 */

let exhausted = new Set<string>(); // models that returned quota errors this session

try { process.loadEnvFile(); } catch { /* .env optional if env vars come from elsewhere */ }

function geminiModels(): string[] {
  return (process.env.GEMINI_MODELS ?? "gemini-3.6-flash,gemini-3-flash-preview,gemini-2.5-flash")
    .split(",").map((m) => m.trim()).filter(Boolean);
}

interface Part { text: string; }
interface MediaPart { inline_data: { mime_type: string; data: string } }
type AnyPart = Part | MediaPart;

export async function geminiCall(
  parts: AnyPart[],
  opts: { json?: boolean; temperature?: number } = {},
): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const models = geminiModels().filter((m) => !exhausted.has(m));
  if (!models.length) throw new Error("all Gemini models quota-exhausted for today (GEMINI_MODELS)");

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
      if (res.status === 429 || (await res.clone().text()).includes("RESOURCE_EXHAUSTED")) {
        exhausted.add(model);
        console.warn(`[llm] ${model} quota-exhausted → next model`);
        continue;
      }
      if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as any;
      return (json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "").trim();
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(`all Gemini models failed — last: ${lastErr}`);
}

/** Text completion via GLM (Zhipu, OpenAI-compatible). Throws if no key. */
export async function glmCall(prompt: string): Promise<string> {
  const key = process.env.GLM_API_KEY;
  if (!key) throw new Error("GLM_API_KEY not set");
  const model = process.env.GLM_MODEL ?? "glm-5.2";
  const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`GLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as any;
  return (json?.choices?.[0]?.message?.content ?? "").trim();
}

/** Text work: GLM if configured, else the Gemini chain. */
export async function textCall(prompt: string): Promise<string> {
  if (process.env.GLM_API_KEY) {
    try { return await glmCall(prompt); }
    catch (e) { console.warn(`[llm] GLM failed (${String(e).slice(0, 120)}) → Gemini`); }
  }
  return geminiCall([{ text: prompt }], { temperature: 0.3 });
}
