import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

import {
  applyTextAnchorMark,
  buildTextIndex,
  locateTextAnchor,
  textSegmentsForAnchor,
  unwrapMarks
} from "../public/highlight-anchors.js";

function content(html) {
  const { document } = parseHTML(`<article class="content">${html}</article>`);
  return document.querySelector(".content");
}

test("position anchors distinguish identical text occurrences", () => {
  const root = content("<p>same sentence</p><p>middle</p><p>same sentence</p>");
  const index = buildTextIndex(root);
  const secondStart = index.text.lastIndexOf("same sentence");
  const count = applyTextAnchorMark(root, {
    selectedText: "same sentence",
    textStart: secondStart,
    textEnd: secondStart + "same sentence".length
  }, { highlightId: "second" });

  assert.equal(count, 1);
  assert.equal(root.querySelectorAll("mark").length, 1);
  assert.equal(root.querySelector("p:first-child mark"), null);
  assert.equal(root.querySelector("p:last-child mark")?.textContent, "same sentence");
  assert.equal(root.querySelector("mark")?.dataset.highlightId, "second");
});

test("legacy quote anchors use prefix and suffix to disambiguate repeats", () => {
  const raw = "before A repeated after A before B repeated after B";
  const result = locateTextAnchor(raw, {
    selectedText: "repeated",
    prefix: "before B ",
    suffix: " after B"
  });

  assert.equal(raw.slice(result.start, result.end), "repeated");
  assert.equal(result.start, raw.lastIndexOf("repeated"));
});

test("a range across inline markup marks only selected characters", () => {
  const root = content("<p>before har<strong>ness design</strong> after</p>");
  const index = buildTextIndex(root);
  const start = index.text.indexOf("harness");
  const anchor = { selectedText: "harness", textStart: start, textEnd: start + 7 };

  assert.equal(textSegmentsForAnchor(root, anchor).length, 2);
  applyTextAnchorMark(root, anchor);

  assert.equal([...root.querySelectorAll("mark")].map((node) => node.textContent).join(""), "harness");
  assert.equal(root.textContent, "before harness design after");
  assert.equal(root.querySelector("strong")?.textContent, "ness design");
});

test("normalized fallback preserves whitespace inside the resolved range", () => {
  const raw = "前文 Agent   harness\n设计 后文";
  const result = locateTextAnchor(raw, { selectedText: "Agent harness 设计" });

  assert.equal(raw.slice(result.start, result.end), "Agent   harness\n设计");
});

test("emoji offsets use JavaScript UTF-16 positions consistently", () => {
  const root = content("<p>start 🧠 harness end</p>");
  const index = buildTextIndex(root);
  const start = index.text.indexOf("harness");
  applyTextAnchorMark(root, {
    selectedText: "harness",
    textStart: start,
    textEnd: start + "harness".length
  });

  assert.equal(root.querySelector("mark")?.textContent, "harness");
  assert.equal(root.textContent, "start 🧠 harness end");
});

test("translation lines are excluded from stable text positions", () => {
  const root = content(`
    <p>Original paragraph</p>
    <div class="translation-line">翻译段落</div>
    <p>Second paragraph</p>
  `);

  assert.equal(buildTextIndex(root).text, "Original paragraphSecond paragraph");
});

test("two identical saved highlights can remain attached to different occurrences", () => {
  const root = content("<p>repeat and repeat</p>");
  applyTextAnchorMark(root, {
    selectedText: "repeat",
    textStart: 0,
    textEnd: 6
  }, { highlightId: "first" });
  applyTextAnchorMark(root, {
    selectedText: "repeat",
    textStart: 11,
    textEnd: 17
  }, { highlightId: "second" });

  assert.deepEqual(
    [...root.querySelectorAll("mark")].map((node) => [node.textContent, node.dataset.highlightId]),
    [["repeat", "first"], ["repeat", "second"]]
  );
});

test("unwrapping one highlight preserves text and neighboring highlights", () => {
  const root = content("<p>alpha beta gamma</p>");
  applyTextAnchorMark(root, { selectedText: "alpha", textStart: 0, textEnd: 5 }, { highlightId: "a" });
  applyTextAnchorMark(root, { selectedText: "gamma", textStart: 11, textEnd: 16 }, { highlightId: "g" });

  unwrapMarks(root, 'mark[data-highlight-id="a"]');

  assert.equal(root.textContent, "alpha beta gamma");
  assert.equal(root.querySelectorAll("mark").length, 1);
  assert.equal(root.querySelector("mark")?.textContent, "gamma");
});
