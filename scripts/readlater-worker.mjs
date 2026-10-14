import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenAICompatibleChatCompletion,
  openAICompatibleConfig
} from "../lib/openai-compatible-chat.mjs";
import {
  buildDigestPrompt,
  buildDigestSystemPrompt,
  buildDigestMapPrompt,
  buildNotionRoutingSystemPrompt,
  buildNotionRoutingPrompt,
  contentAroundHighlights,
  parseDigestResponse
} from "../lib/digest-workflow.mjs";
import { createTingwuProvider, isTingwuConfigured, tingwuConfig } from "../lib/tingwu.mjs";
import { createTranscriptChunks } from "../lib/transcription.mjs";
import { advanceTranscriptionJob } from "../lib/transcription-worker.mjs";

if (process.env.TINGWU_CREDENTIALS_FILE) {
  try {
    process.loadEnvFile(resolve(process.env.TINGWU_CREDENTIALS_FILE));
  } catch (error) {
    console.error(`Unable to load TINGWU_CREDENTIALS_FILE: ${error.message}`);
    process.exit(1);
  }
}

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const baseUrl = (process.env.READLATER_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const workerToken = process.env.READLATER_WORKER_TOKEN || "";
const digestPromptPath = process.env.DIGEST_PROMPT_PATH
  ? resolve(process.env.DIGEST_PROMPT_PATH)
  : join(rootDir, "prompts/digest.md");
const logDir = process.env.READLATER_WORKER_LOG_DIR || join(rootDir, "output/digest-logs");
const pollMs = Number(process.env.READLATER_WORKER_POLL_MS || 5000);
const providerRetryCount = Number(process.env.AI_RETRY_COUNT || 3);
const providerRetryDelayMs = Number(process.env.AI_RETRY_DELAY_MS || 3000);
const once = process.argv.includes("--once");
const workerId = process.env.READLATER_WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;

if (!workerToken) {
  console.error("READLATER_WORKER_TOKEN is required.");
  process.exit(1);
}

function normalizeProvider() {
  return "openai_compatible";
}

function providerConfig() {
  const config = openAICompatibleConfig();
  return {
    provider: "openai_compatible",
    label: `OpenAI-compatible · ${config.model}`,
    url: config.url,
    model: config.model
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${workerToken}`,
      "X-Readlater-Worker-Id": workerId,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function nextRunAt(delayMs) {
  return new Date(Date.now() + delayMs).toISOString();
}

async function updateTranscriptionJob(job, body) {
  return request(`/api/transcription-jobs/${job.id}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}

async function processNextTranscriptionJob(provider) {
  if (!provider) return false;
  const { job } = await request("/api/transcription-jobs/next");
  if (!job) return false;
  console.log(`[readlater-worker] transcription ${job.id} (${job.stage})`);

  try {
    const outcome = await advanceTranscriptionJob(job, provider);
    if (outcome.type === "complete") {
      await request(`/api/transcription-jobs/${job.id}/result`, {
        method: "POST",
        body: JSON.stringify(outcome.body)
      });
      console.log(`[readlater-worker] transcription done ${job.id} (${outcome.body.segments.length} segments)`);
      return true;
    }
    await updateTranscriptionJob(job, outcome.body);
    if (job.stage === "submit") console.log(`[readlater-worker] transcription submitted ${job.id}`);
    return true;
  } catch (error) {
    const errorAttempts = Number(job.errorAttempts || 0) + 1;
    const canRetryPoll = job.stage === "poll" && error.retryable !== false && errorAttempts < 8;
    await updateTranscriptionJob(job, canRetryPoll ? {
      status: "waiting",
      stage: "poll",
      nextRunAt: nextRunAt(Math.min(provider.pollMs * (2 ** Math.max(0, errorAttempts - 1)), 5 * 60 * 1000)),
      errorAttempts,
      error: error.message
    } : {
      status: "failed",
      stage: job.stage,
      errorAttempts,
      error: error.message
    });
    console.error(`[readlater-worker] transcription failed ${job.id}: ${error.message}`);
    return true;
  }
}

function safeFilename(value = "") {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function retryDelayMs(attempt) {
  return providerRetryDelayMs * (2 ** attempt);
}

function isRetryableProviderError(error) {
  return /AI provider HTTP (429|5\d\d)|fetch failed|timed out/i.test(error?.message || "");
}

async function createProviderCompletionWithRetry(prompt, job, systemPrompt) {
  let lastError;
  for (let attempt = 0; attempt <= providerRetryCount; attempt += 1) {
    try {
      return await createOpenAICompatibleChatCompletion(prompt, { systemPrompt });
    } catch (error) {
      lastError = error;
      if (!isRetryableProviderError(error) || attempt === providerRetryCount) throw error;
      const delay = retryDelayMs(attempt);
      console.warn(`[readlater-worker] retrying ${job.id} after ${delay}ms: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function writeJobLog(job, prompt, result = {}) {
  const timestamp = new Date().toISOString();
  const config = providerConfig();
  const logName = `${timestamp.replaceAll(":", "-")}-${safeFilename(job.id)}-${safeFilename(job.mode)}.md`;
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, logName), [
    "# Readlater Digest Worker Log",
    "",
    "## Metadata",
    "",
    "```json",
    JSON.stringify({
      jobId: job.id,
      articleId: job.articleId,
      mode: job.mode,
      status: result.status || "running",
      instruction: job.instruction || "",
      provider: config.provider,
      providerLabel: config.label,
      providerUrl: config.url,
      model: config.model,
      baseUrl,
      digestPromptPath,
      createdAt: job.createdAt,
      loggedAt: timestamp,
      error: result.error || ""
    }, null, 2),
    "```",
    "",
    "## Prompt Sent To AI Provider",
    "",
    "```text",
    prompt,
    "```",
    "",
    "## AI Provider Output",
    "",
    "```text",
    result.content || "",
    "```"
  ].join("\n"), "utf8");
  return logName;
}

async function writeJobLogSafely(job, prompt, result = {}) {
  try {
    const logName = await writeJobLog(job, prompt, result);
    console.log(`[readlater-worker] log ${join(logDir, logName)}`);
  } catch (error) {
    console.error(`[readlater-worker] log failed ${job.id}: ${error.message}`);
  }
}

async function processNextJob(digestInstructions) {
  const { job } = await request("/api/digest-jobs/next");
  if (!job) return false;

  const provider = normalizeProvider(job.provider);
  console.log(`[readlater-worker] running ${job.id} (${job.mode}, ${provider})`);
  let prompt = "";
  try {
    let effectiveJob = job;
    if (job.mode !== "notion_route" && job.inputSnapshot?.contentType === "podcast_episode") {
      const snapshot = job.inputSnapshot;
      const source = snapshot.contentMarkdown || snapshot.contentText || "";
      const highlightContext = job.mode === "sop_a_echo_marks" ? contentAroundHighlights(snapshot) : "";
      if (highlightContext) {
        effectiveJob = {
          ...job,
          inputSnapshot: { ...snapshot, contentMarkdown: highlightContext, contentText: "" }
        };
      } else {
        const chunks = createTranscriptChunks(source);
        if (chunks.length > 1) {
          const summaries = [];
          for (let index = 0; index < chunks.length; index += 1) {
            const mapPrompt = buildDigestMapPrompt(chunks[index], index, chunks.length);
            summaries.push(await createProviderCompletionWithRetry(
              mapPrompt,
              job,
              "你负责忠实压缩播客文稿分块，为后续整体消化保留必要信息。不要编造，不要输出控制协议。"
            ));
          }
          effectiveJob = {
            ...job,
            inputSnapshot: {
              ...snapshot,
              contentMarkdown: summaries.map((summary, index) => `## 文稿分块 ${index + 1}\n\n${summary}`).join("\n\n"),
              contentText: ""
            }
          };
        }
      }
    }
    prompt = job.mode === "notion_route"
      ? buildNotionRoutingPrompt(effectiveJob)
      : buildDigestPrompt(effectiveJob);
    const systemPrompt = job.mode === "notion_route"
      ? buildNotionRoutingSystemPrompt()
      : buildDigestSystemPrompt(digestInstructions);
    const rawContent = await createProviderCompletionWithRetry(prompt, job, systemPrompt);
    const parsed = job.mode === "notion_route"
      ? { content: rawContent, actions: [] }
      : parseDigestResponse(rawContent);
    const content = parsed.content || (parsed.actions.length
      ? "好的，我会将本次讨论沉淀到 Notion，并按内容选择合适的主题。"
      : "");
    let routing;
    if (job.mode === "notion_route") {
      try {
        routing = JSON.parse(content);
      } catch {
        throw new Error("Notion 路由模型没有返回合法 JSON");
      }
    }
    await request(`/api/digest-jobs/${job.id}/result`, {
      method: "POST",
      body: JSON.stringify({ status: "done", content, routing, actions: parsed.actions })
    });
    await writeJobLogSafely(job, prompt, { status: "done", content });
    console.log(`[readlater-worker] done ${job.id}`);
  } catch (error) {
    await request(`/api/digest-jobs/${job.id}/result`, {
      method: "POST",
      body: JSON.stringify({ status: "failed", error: error.message })
    });
    if (prompt) {
      await writeJobLogSafely(job, prompt, { status: "failed", error: error.message });
    }
    console.error(`[readlater-worker] failed ${job.id}: ${error.message}`);
  }
  return true;
}

async function main() {
  const digestInstructions = await readFile(digestPromptPath, "utf8");
  const config = providerConfig();
  console.log(`[readlater-worker] polling ${baseUrl}`);
  console.log(`[readlater-worker] digest instructions ${digestPromptPath}`);
  console.log(`[readlater-worker] provider ${config.label}`);
  console.log(`[readlater-worker] endpoint ${config.url}`);
  console.log(`[readlater-worker] log dir ${logDir}`);
  const transcriptionProvider = String(process.env.TRANSCRIPTION_PROVIDER || "tingwu").toLowerCase() === "tingwu"
    && isTingwuConfigured()
    ? createTingwuProvider()
    : null;
  console.log(`[readlater-worker] transcription ${transcriptionProvider ? "Tingwu enabled" : "disabled (credentials not configured)"}`);
  if (transcriptionProvider) {
    const transcriptionConfig = tingwuConfig();
    console.log(`[readlater-worker] transcription language ${transcriptionConfig.sourceLanguage} · diarization ${transcriptionConfig.diarizationEnabled ? `enabled (${transcriptionConfig.speakerCount || "auto"})` : "disabled"}`);
  }
  do {
    try {
      const transcriptionProcessed = await processNextTranscriptionJob(transcriptionProvider);
      const digestProcessed = transcriptionProcessed ? false : await processNextJob(digestInstructions);
      const processed = transcriptionProcessed || digestProcessed;
      if (once) break;
      if (!processed) await new Promise((resolve) => setTimeout(resolve, pollMs));
    } catch (error) {
      console.error(`[readlater-worker] ${error.message}`);
      if (once) process.exitCode = 1;
      if (once) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } while (true);
}

main();
