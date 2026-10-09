import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAICompatibleChatCompletion,
  extractChatCompletionContent
} from "../lib/openai-compatible-chat.mjs";

test("extractChatCompletionContent supports string and content-part responses", () => {
  assert.equal(extractChatCompletionContent({
    choices: [{ message: { content: "  answer  " } }]
  }), "answer");
  assert.equal(extractChatCompletionContent({
    choices: [{ message: { content: [{ type: "text", text: "first" }, { type: "text", text: " second" }] } }]
  }), "first second");
});

test("createOpenAICompatibleChatCompletion sends an OpenAI-compatible request", async () => {
  let request;
  const content = await createOpenAICompatibleChatCompletion("digest this", {
    systemPrompt: "Digest skill system prompt",
    env: {
      OPENAI_COMPAT_API_KEY: "test-secret",
      OPENAI_COMPAT_API_URL: "https://provider.test/chat/completions",
      OPENAI_COMPAT_MODEL: "test-model",
      OPENAI_COMPAT_TIMEOUT_MS: "1000"
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: "完成" } }] }), { status: 200 });
    }
  });

  assert.equal(content, "完成");
  assert.equal(request.url, "https://provider.test/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer test-secret");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "Digest skill system prompt");
  assert.equal(body.messages.at(-1).content, "digest this");
});

test("createOpenAICompatibleChatCompletion surfaces structured API errors", async () => {
  await assert.rejects(
    createOpenAICompatibleChatCompletion("digest this", {
      env: { OPENAI_COMPAT_API_KEY: "test-token" },
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "denied" } }), { status: 401 })
    }),
    /AI provider HTTP 401: denied/
  );
});
