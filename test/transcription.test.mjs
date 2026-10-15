import test from "node:test";
import assert from "node:assert/strict";
import {
  claimNextTranscriptionJob,
  createTranscriptChunks,
  extractTranscriptionHotwords,
  inferTranscriptionSpeakerCount,
  normalizeTranscriptSegments,
  sanitizeTranscriptSegments,
  transcriptToDocument
} from "../lib/transcription.mjs";

test("episode metadata produces deduplicated, provider-safe domain hotwords", () => {
  const hotwords = extractTranscriptionHotwords({
    title: "一个 Personal Agent 创业者的思考｜对谈 Ambi 创始人子皓",
    showName: "42章经",
    description: "从 Openclaw、Hermes，到 Muse、Instinct。54 号珍藏：莫子皓，Ambi 创始人，曾任 Plaud 合伙人。简评 Town、Grok Bot，很多产品的 Proactive 都做错了。https://example.com/form"
  });
  assert.deepEqual(hotwords.slice(0, 5), ["42章经", "Personal", "Agent", "Ambi", "子皓"]);
  assert.ok(["Openclaw", "Hermes", "Muse", "Instinct", "莫子皓", "Plaud", "Town", "Grok", "Proactive"]
    .every((word) => hotwords.includes(word)));
  assert.equal(hotwords.filter((word) => word.toLowerCase() === "ambi").length, 1);
  assert.ok(hotwords.every((word) => [...word].length <= 10 && /^[\p{Script=Han}A-Za-z0-9]+$/u.test(word)));
  assert.equal(hotwords.includes("https"), false);
});

test("speaker count is fixed only when metadata strongly indicates a conversation", () => {
  assert.equal(inferTranscriptionSpeakerCount({ title: "对谈 Ambi 创始人" }), 2);
  assert.equal(inferTranscriptionSpeakerCount({ description: "本期嘉宾分享创业经历" }), 2);
  assert.equal(inferTranscriptionSpeakerCount({ title: "一个人的产品复盘" }), 0);
});

test("Tingwu word output is grouped by sentence and sorted by timestamp", () => {
  const segments = normalizeTranscriptSegments({
    Transcription: {
      Paragraphs: [{
        Words: [
          { SentenceId: 2, Start: 2000, End: 2200, Text: "第二", SpeakerId: "2" },
          { SentenceId: 2, Start: 2200, End: 2500, Text: "句" },
          { SentenceId: 1, Start: 100, End: 300, Text: "第一" },
          { SentenceId: 1, Start: 300, End: 500, Text: "句" }
        ]
      }]
    }
  });
  assert.deepEqual(segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), [
    { startMs: 100, endMs: 500, text: "第一句" },
    { startMs: 2000, endMs: 2500, text: "第二句" }
  ]);
});

test("audio event speech ranges remove recognition produced entirely in music", () => {
  const segments = normalizeTranscriptSegments({
    Transcription: {
      AudioSegments: [[10000, 30000]],
      Paragraphs: [
        { Start: 0, End: 4000, Text: "Do something there." },
        { Start: 12000, End: 15000, Text: "欢迎收听。" }
      ]
    }
  });
  assert.deepEqual(segments.map((segment) => segment.text), ["欢迎收听。"]);
});

test("a separated English lyric at the start of a Chinese podcast is treated as intro music", () => {
  const segments = normalizeTranscriptSegments({
    Transcription: {
      AudioInfo: { Language: "cn" },
      Paragraphs: [
        { Start: 2000, End: 4100, Text: "Do something." },
        { Start: 4100, End: 5000, Text: "there." },
        { Start: 19880, End: 22984, Text: "欢迎收听今天的节目。" }
      ]
    }
  });
  assert.deepEqual(segments.map((segment) => segment.text), ["欢迎收听今天的节目。"]);
});
test("transcript sanitizer clamps timestamps, drops empty text, and limits untrusted fields", () => {
  assert.deepEqual(sanitizeTranscriptSegments([
    { start: -5, end: 10.4, text: "  hello  ", speaker: "speaker-1" },
    { start: 20, end: 10, text: "world" },
    { text: "   " }
  ]), [
    { startMs: 0, endMs: 10, text: "hello", speaker: "speaker-1" },
    { startMs: 20, endMs: 20, text: "world", speaker: "" }
  ]);
});

test("stable transcript document preserves sentence order and deterministic paragraph boundaries", () => {
  const input = [
    { startMs: 0, endMs: 100, text: "第一句话。" },
    { startMs: 100, endMs: 200, text: "第二句话。" },
    { startMs: 200, endMs: 300, text: "第三句话很长。" }
  ];
  const first = transcriptToDocument(input, { paragraphCharacters: 12 });
  const second = transcriptToDocument(input, { paragraphCharacters: 12 });
  assert.deepEqual(first, second);
  assert.equal(first.contentText, "第一句话。第二句话。\n\n第三句话很长。");
  assert.equal(first.contentMarkdown, first.contentText);
});

test("transcript document separates speakers and assigns stable display labels", () => {
  const document = transcriptToDocument([
    { startMs: 0, endMs: 900, text: "欢迎收听。", speaker: "speaker-b", paragraphIndex: 0 },
    { startMs: 950, endMs: 1800, text: "今天聊产品。", speaker: "speaker-b", paragraphIndex: 0 },
    { startMs: 65000, endMs: 67000, text: "我先说一个看法。", speaker: "speaker-a", paragraphIndex: 1 },
    { startMs: 67100, endMs: 69000, text: "这是第二句话。", speaker: "speaker-a", paragraphIndex: 1 },
    { startMs: 70000, endMs: 71000, text: "继续。", speaker: "speaker-b", paragraphIndex: 2 }
  ]);
  assert.equal(document.contentText, [
    "说话人 1 · 00:00",
    "欢迎收听。今天聊产品。",
    "说话人 2 · 01:05",
    "我先说一个看法。这是第二句话。",
    "说话人 1 · 01:10",
    "继续。"
  ].join("\n\n"));
});

test("transcript document breaks on long silence, provider paragraphs, and length at sentence boundaries", () => {
  const document = transcriptToDocument([
    { startMs: 0, endMs: 100, text: "第一句话。", paragraphIndex: 0 },
    { startMs: 150, endMs: 250, text: "第二句话。", paragraphIndex: 1 },
    { startMs: 3000, endMs: 3200, text: "停顿之后。", paragraphIndex: 1 },
    { startMs: 3300, endMs: 3500, text: "特别长的一句话。", paragraphIndex: 1 }
  ], {
    paragraphCharacters: 12,
    minimumParagraphCharacters: 4,
    silenceGapMs: 2000
  });
  assert.equal(document.contentText, [
    "第一句话。",
    "第二句话。",
    "停顿之后。",
    "特别长的一句话。"
  ].join("\n\n"));
});

test("speaker id is preserved when it appears after the first word", () => {
  const [segment] = normalizeTranscriptSegments({
    Transcription: {
      Paragraphs: [{
        Words: [
          { SentenceId: 1, Start: 0, End: 50, Text: "你" },
          { SentenceId: 1, Start: 50, End: 100, Text: "好", SpeakerId: "7" }
        ]
      }]
    }
  });
  assert.equal(segment.speaker, "7");
  assert.equal(segment.paragraphIndex, 0);
});

test("long transcripts are chunked within the target budget with overlap", () => {
  const text = ["A".repeat(80), "B".repeat(80), "C".repeat(80)].join("\n\n");
  const chunks = createTranscriptChunks(text, { maxCharacters: 170, overlapCharacters: 10 });
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 172));
  assert.match(chunks[1], /^B{10}\n\nC/);
});

test("job claim respects due time, lease, ordering, and recovers expired work", () => {
  const jobs = [
    { id: "later", status: "waiting", nextRunAt: "2026-01-01T00:10:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "queued", status: "queued", createdAt: "2025-12-31T23:59:00.000Z" },
    { id: "expired", status: "running", leaseExpiresAt: "2025-12-31T23:59:30.000Z", createdAt: "2025-12-31T23:58:00.000Z" }
  ];
  const claimed = claimNextTranscriptionJob(jobs, {
    workerId: "worker-a",
    now: new Date("2026-01-01T00:00:00.000Z"),
    leaseMs: 60000
  });
  assert.equal(claimed.id, "expired");
  assert.equal(claimed.status, "running");
  assert.equal(claimed.workerId, "worker-a");
  assert.equal(claimed.leaseExpiresAt, "2026-01-01T00:01:00.000Z");
  assert.equal(claimed.attempts, 1);
});
