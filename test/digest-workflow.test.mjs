import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDigestPrompt,
  buildDigestSystemPrompt,
  buildNotionRoutingSystemPrompt,
  buildNotionRoutingPrompt,
  createDigestInputSnapshot,
  digestModeInstruction,
  formatDigestConversation,
  formatNotionConversation,
  parseDigestResponse
} from "../lib/digest-workflow.mjs";
import { DIGEST_ACTIONS } from "../public/digest-config.js";

test("digest input snapshot stays immutable when article messages change", () => {
  const article = {
    title: "Example",
    highlights: [{ selectedText: "original", note: "first note" }],
    aiMessages: [{ role: "assistant", content: "existing answer" }]
  };

  const snapshot = createDigestInputSnapshot(article);
  article.highlights[0].note = "changed note";
  article.aiMessages.push({ role: "user", content: "new instruction" });

  assert.equal(snapshot.highlights[0].note, "first note");
  assert.deepEqual(snapshot.aiMessages, [{ role: "assistant", content: "existing answer" }]);
});

test("digest system contains the skill while user prompt contains runtime context", () => {
  const prompt = buildDigestPrompt({
    mode: "sop_b_ai_marks",
    instruction: "请先读先标注",
    inputSnapshot: {
      title: "Example",
      contentText: "Plain duplicate",
      contentMarkdown: "# Structured article",
      media: [{ type: "image", url: "https://example.com/image.png" }],
      notes: [{ content: "Standalone note" }],
      aiMessages: [
        { role: "user", content: "之前的问题" },
        { role: "assistant", content: "之前的回答" }
      ]
    }
  });
  const systemPrompt = buildDigestSystemPrompt("Follow the digest rules.");

  assert.match(prompt, /<turn index="1" role="echo">\n之前的问题\n<\/turn>/);
  assert.match(prompt, /<turn index="2" role="ai">\n之前的回答\n<\/turn>/);
  assert.doesNotMatch(formatDigestConversation([{ role: "user", content: "问题" }]), /^user:/m);
  assert.match(prompt, /<current_request>\n请先读先标注\n<\/current_request>/);
  assert.match(prompt, /正文：\n# Structured article/);
  assert.doesNotMatch(prompt, /Plain duplicate/);
  assert.doesNotMatch(prompt, /媒体：/);
  assert.doesNotMatch(prompt, /Standalone note/);
  assert.match(prompt, /遵循 system 中的正文与动作块协议/);
  assert.doesNotMatch(prompt, /Follow the digest rules/);
  assert.match(systemPrompt, /Follow the digest rules/);
  assert.match(systemPrompt, /sync_notion/);
  assert.match(systemPrompt, /由 Readlater runtime 从已保存数据中直接读取/);
  assert.match(systemPrompt, /不要为同步目的重写、补全或伪造原文/);
});

test("Notion conversation preserves both Echo and AI turns", () => {
  assert.equal(formatNotionConversation([
    { role: "user", content: "这个观点成立吗？" },
    { role: "assistant", content: "部分成立。" }
  ]), "### Echo\n\n这个观点成立吗？\n\n### AI\n\n部分成立。");
});

test("digest response actions are stripped from visible content and validated", () => {
  assert.deepEqual(parseDigestResponse([
    "好的，开始沉淀。",
    '<readlater_actions>{"actions":[{"type":"sync_notion"}]}</readlater_actions>'
  ].join("\n")), {
    content: "好的，开始沉淀。",
    actions: [{ type: "sync_notion" }]
  });
  assert.deepEqual(parseDigestResponse([
    "继续讨论。",
    '<readlater_actions>{"actions":[{"type":"unknown"}]}</readlater_actions>'
  ].join("\n")), {
    content: "继续讨论。",
    actions: []
  });
});

test("L1 uses Echo marks and L2 asks AI to read and mark first", () => {
  assert.deepEqual(DIGEST_ACTIONS.map(({ label, mode }) => ({ label, mode })), [
    { label: "L1", mode: "sop_a_echo_marks" },
    { label: "L2", mode: "sop_b_ai_marks" }
  ]);
  assert.match(digestModeInstruction(DIGEST_ACTIONS[0].mode), /Echo 已写/);
  assert.match(digestModeInstruction(DIGEST_ACTIONS[1].mode), /AI 先读先标注/);
});

test("Notion routing prompt limits the model to configured destinations and JSON", () => {
  const prompt = buildNotionRoutingPrompt({
    inputSnapshot: {
      title: "A title",
      url: "https://example.com",
      highlights: [{ selectedText: "Keep original" }],
      notes: [{ content: "Echo note" }]
    },
    sourceDigestContent: "A discussion result",
    notionDestinations: [{ key: "agent-product", name: "AI 产品与 Agent", description: "Agent architecture" }]
  });
  assert.match(prompt, /只能从这些主题中选择/);
  assert.match(prompt, /agent-product/);
  assert.match(prompt, /只返回一个合法 JSON 对象/);
  assert.match(prompt, /不能改写、概括或伪造高亮/);
  assert.match(prompt, /"title":"认知条目标题"/);
  assert.match(prompt, /"discussion":"基于本次对话整理的讨论内容"/);
  assert.match(prompt, /同一主题可以有多个不同条目/);
  assert.doesNotMatch(prompt, /Echo note/);
  assert.doesNotMatch(prompt, /noteIndexes/);
  assert.match(buildNotionRoutingSystemPrompt(), /只返回.*合法 JSON/);
  assert.match(buildNotionRoutingSystemPrompt(), /不能生成、改写或补全标注原文/);
});
