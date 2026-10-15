import test from "node:test";
import assert from "node:assert/strict";
import { correctTranscriptSegments } from "../lib/transcript-correction.mjs";

test("trusted recurring ASR aliases are corrected even without an LLM", async () => {
  const result = await correctTranscriptSegments([
    { startMs: 0, endMs: 100, text: "安碧的方式子皓讲了open cloud和minus。", speaker: "1" }
  ], { hotwords: ["Ambi", "子皓", "Agent"] });
  assert.equal(result.segments[0].text, "Ambi的创始人子皓讲了OpenClaw和Manus。");
  assert.equal(result.metadata.provider, "deterministic");
  assert.equal(result.metadata.correctedSegments, 1);
});

test("transcript correction preserves timestamps and speaker structure", async () => {
  const input = [
    { startMs: 100, endMs: 500, speaker: "1", paragraphIndex: 0, text: "安碧的方式子皓。" },
    { startMs: 600, endMs: 1000, speaker: "2", paragraphIndex: 1, text: "open cloud很火。" }
  ];
  const result = await correctTranscriptSegments(input, {
    hotwords: ["Ambi", "OpenClaw", "Agent"],
    complete: async (prompt, systemPrompt) => {
      assert.match(systemPrompt, /Manus/);
      const values = JSON.parse(prompt);
      return JSON.stringify(values.map((value) => ({
        id: value.id,
        text: value.id === 0 ? "Ambi的创始人子皓。" : "OpenClaw很火。"
      })));
    }
  });
  assert.deepEqual(result.segments, [
    { startMs: 100, endMs: 500, speaker: "1", paragraphIndex: 0, text: "Ambi的创始人子皓。" },
    { startMs: 600, endMs: 1000, speaker: "2", paragraphIndex: 1, text: "OpenClaw很火。" }
  ]);
  assert.equal(result.metadata.correctedSegments, 2);
  assert.equal(result.metadata.failedChunks, 0);
});

test("transcript correction falls back to raw text for malformed or over-rewritten output", async () => {
  const input = [{ startMs: 0, endMs: 100, text: "这是一句保持原意的较长测试文本。", speaker: "1" }];
  const malformed = await correctTranscriptSegments(input, { complete: async () => "not json", shouldCorrect: () => true });
  assert.equal(malformed.segments[0].text, input[0].text);
  assert.equal(malformed.metadata.failedChunks, 1);

  const rewritten = await correctTranscriptSegments(input, {
    complete: async () => JSON.stringify([{ id: 0, text: "完全不同且添加了大量不存在的内容，应该被校验器拒绝并回退到原始文稿。" }]),
    shouldCorrect: () => true
  });
  assert.equal(rewritten.segments[0].text, input[0].text);
  assert.equal(rewritten.metadata.failedChunks, 0);
  assert.equal(rewritten.metadata.rejectedSegments, 1);
});

test("transcript correction accepts fenced JSON and splits large inputs without losing ids", async () => {
  const input = Array.from({ length: 10 }, (_, index) => ({
    startMs: index * 100,
    endMs: index * 100 + 90,
    text: `第${index}句 Openclaw。`,
    speaker: "1"
  }));
  let calls = 0;
  const result = await correctTranscriptSegments(input, {
    hotwords: ["OpenClaw"],
    maxCharacters: 500,
    complete: async (prompt) => {
      calls += 1;
      return `\`\`\`json\n${JSON.stringify(JSON.parse(prompt).map((item) => ({ ...item, text: item.text.replace("Openclaw", "OpenClaw") })))}\n\`\`\``;
    }
  });
  assert.ok(calls >= 1);
  assert.ok(result.segments.every((segment) => segment.text.includes("OpenClaw")));
  assert.deepEqual(result.segments.map((segment) => segment.startMs), input.map((segment) => segment.startMs));
});
