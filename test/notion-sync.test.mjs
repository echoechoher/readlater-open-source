import test from "node:test";
import assert from "node:assert/strict";
import {
  appendNotionPage,
  buildNotionEntryMarkdown,
  normalizeNotionPageId,
  validateNotionConnection
} from "../lib/notion-sync.mjs";

test("normalizeNotionPageId accepts a page URL, UUID, and compact page ID", () => {
  const expected = "01234567-89ab-cdef-0123-456789abcdef";
  assert.equal(normalizeNotionPageId("0123456789abcdef0123456789abcdef"), expected);
  assert.equal(normalizeNotionPageId(expected), expected);
  assert.equal(
    normalizeNotionPageId("https://www.notion.so/Workspace-0123456789abcdef0123456789abcdef?pvs=4"),
    expected
  );
  assert.equal(normalizeNotionPageId("not-a-page"), "");
});

test("buildNotionEntryMarkdown matches the existing digested topic-page format", () => {
  const markdown = buildNotionEntryMarkdown({
    title: "Source article",
    url: "https://example.com/source",
    highlights: [
      { selectedText: "Exact source line one.\nExact source line two.", note: "Keep my exact thought." },
      { selectedText: "Another exact quote.", note: "" }
    ]
  }, {
    title: "A concise insight",
    discussion: "The model-generated discussion."
  });

  assert.equal(markdown, [
    "### A concise insight",
    "**标注：**",
    "> Exact source line one.<br>Exact source line two.",
    "*我的想法：Keep my exact thought.*",
    "> Another exact quote.",
    "**讨论：**",
    "The model-generated discussion.",
    "← [Source article](https://example.com/source)",
    "---"
  ].join("\n"));
});

test("buildNotionEntryMarkdown keeps a leading bullet on the same line as its text", () => {
  const markdown = buildNotionEntryMarkdown({
    title: "Source article",
    url: "https://example.com/source",
    highlights: [
      { selectedText: "●\n\n所谓的掉队焦虑并不符合真实经济的扩散速度。", note: "" }
    ]
  }, {
    title: "AI 扩散速度",
    discussion: ""
  });

  assert.match(markdown, /> ● 所谓的掉队焦虑并不符合真实经济的扩散速度。/);
  assert.doesNotMatch(markdown, /> ●<br>/);
});

test("appendNotionPage appends markdown to an existing topic page", async () => {
  let request;
  const result = await appendNotionPage({
    token: "secret",
    pageId: "0123456789abcdef0123456789abcdef",
    markdown: "### New insight\n---",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ object: "page_markdown", markdown: "existing\nnew" }), { status: 200 });
    }
  });

  assert.equal(request.url, "https://api.notion.com/v1/pages/01234567-89ab-cdef-0123-456789abcdef/markdown");
  assert.equal(request.options.method, "PATCH");
  assert.deepEqual(JSON.parse(request.options.body), {
    type: "insert_content",
    insert_content: {
      content: "### New insight\n---",
      position: { type: "end" }
    }
  });
  assert.equal(result.pageId, "01234567-89ab-cdef-0123-456789abcdef");
});

test("validateNotionConnection uses the current Notion API version", async () => {
  let request;
  const result = await validateNotionConnection({
    token: "secret",
    parentPageId: "0123456789abcdef0123456789abcdef",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        url: "https://www.notion.so/target",
        properties: { title: { title: [{ plain_text: "Target page" }] } }
      }), { status: 200 });
    }
  });
  assert.equal(request.url, "https://api.notion.com/v1/pages/01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.equal(request.options.headers["Notion-Version"], "2026-03-11");
  assert.equal(result.pageTitle, "Target page");
});

test("Notion API errors are actionable", async () => {
  await assert.rejects(
    validateNotionConnection({
      token: "secret",
      parentPageId: "0123456789abcdef0123456789abcdef",
      fetchImpl: async () => new Response(JSON.stringify({ message: "restricted" }), { status: 403 })
    }),
    /没有写入目标页面的权限/
  );
});
