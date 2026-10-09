function responseErrorMessage(data, fallback) {
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.error?.message === "string") return data.error.message;
  if (typeof data?.message === "string") return data.message;
  return fallback;
}

export function extractChatCompletionContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : (part?.text || ""))
      .join("")
      .trim();
  }
  return "";
}

export function openAICompatibleConfig(env = process.env) {
  return {
    token: env.OPENAI_COMPAT_API_KEY || "",
    url: env.OPENAI_COMPAT_API_URL || "https://api.openai.com/v1/chat/completions",
    model: env.OPENAI_COMPAT_MODEL || "gpt-4o-mini",
    timeoutMs: Number(env.OPENAI_COMPAT_TIMEOUT_MS || 600000)
  };
}

const DEFAULT_SYSTEM_PROMPT = "You are the Readlater digest assistant. Follow the user's digest instructions exactly and answer in Chinese unless asked otherwise. Return only the assistant reply. Never simulate a later user turn or emit user/assistant role labels.";

export async function createOpenAICompatibleChatCompletion(prompt, {
  env = process.env,
  fetchImpl = fetch,
  systemPrompt = DEFAULT_SYSTEM_PROMPT
} = {}) {
  const config = openAICompatibleConfig(env);
  if (!config.token) {
    throw new Error("OPENAI_COMPAT_API_KEY is required.");
  }

  let response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.token}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          { role: "user", content: prompt }
        ]
      }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new Error(`AI provider request timed out after ${config.timeoutMs}ms.`);
    }
    throw new Error(`AI provider request failed: ${error.message}`);
  }

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    if (!response.ok) throw new Error(`AI provider HTTP ${response.status}: ${raw.slice(0, 500)}`);
    throw new Error("AI provider returned a non-JSON response.");
  }

  if (!response.ok) {
    throw new Error(`AI provider HTTP ${response.status}: ${responseErrorMessage(data, "Unknown error")}`);
  }

  const content = extractChatCompletionContent(data);
  if (!content) throw new Error("AI provider returned no assistant content.");
  return content;
}
