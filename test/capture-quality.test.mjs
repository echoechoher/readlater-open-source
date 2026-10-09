import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCaptureQuality,
  shouldPreferCapturedContent
} from "../lib/capture-quality.mjs";

test("marks captures with missing tables or images for review", () => {
  const quality = evaluateCaptureQuality({
    captureMetrics: {
      source: { textLength: 5000, tables: 2, images: 6, headings: 8 },
      output: { textLength: 5000, tables: 0, images: 1, headings: 8 }
    },
    contentText: "正文".repeat(2500),
    contentMarkdown: "### 标题\n\n正文"
  });
  assert.equal(quality.status, "needs_review");
  assert.deepEqual(quality.issues.sort(), ["heading_loss", "image_loss", "table_loss"]);
});

test("accepts a structurally complete semantic capture", () => {
  const markdown = [
    "## 第一部分",
    "",
    "| 产品 | 策略 |",
    "| --- | --- |",
    "| Codex | handoff |",
    "",
    "![流程图](/media/example.png)"
  ].join("\n");
  const quality = evaluateCaptureQuality({
    captureMetrics: {
      source: { textLength: 20, tables: 1, images: 1, headings: 1 },
      output: { textLength: 20, tables: 1, images: 1, headings: 1 }
    },
    contentText: "第一部分产品策略 Codex handoff",
    contentMarkdown: markdown
  });
  assert.equal(quality.status, "ready");
  assert.deepEqual(quality.issues, []);
});

test("does not replace a complete capture with a shorter media-poor recapture", () => {
  const existing = {
    contentVersion: 3,
    fetchStatus: "ready",
    contentText: "完整正文".repeat(1000),
    contentMarkdown: "## 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![图](/media/a.png)",
    media: [{ type: "image", url: "/media/a.png" }]
  };
  const incoming = {
    contentVersion: 3,
    contentText: "较短正文".repeat(500),
    contentMarkdown: "## 标题\n\n较短正文",
    media: [],
    captureQuality: { status: "needs_review", issues: ["image_loss", "table_loss"] }
  };
  assert.equal(shouldPreferCapturedContent(existing, incoming), false);
});

test("allows a version-three capture to repair a flatter legacy article", () => {
  const existing = {
    contentVersion: 2,
    fetchStatus: "ready",
    contentText: "正文".repeat(1000),
    contentMarkdown: "正文".repeat(1000),
    media: [{ type: "image", url: "https://example.com/one.png" }]
  };
  const incoming = {
    contentVersion: 3,
    contentText: "正文".repeat(1000),
    contentMarkdown: "## 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![图](/media/a.png)",
    media: [{ type: "image", url: "/media/a.png" }],
    captureQuality: { status: "ready", issues: [] }
  };
  assert.equal(shouldPreferCapturedContent(existing, incoming), true);
});
