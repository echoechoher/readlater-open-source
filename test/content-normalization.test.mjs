import test from "node:test";
import assert from "node:assert/strict";

import {
  htmlToMarkdown,
  htmlToSemanticCapture,
  markdownMetrics,
  normalizeMarkdownPreservingCode,
  normalizeProseWhitespace,
  selectContentHtml
} from "../lib/content-normalization.mjs";

test("removes meaningless CJK spacing while preserving Latin word spacing", () => {
  assert.equal(
    normalizeProseWhitespace("训练推动      模式 —— Agent first"),
    "训练推动模式 —— Agent first"
  );
  assert.equal(normalizeProseWhitespace("文字 ： 示例"), "文字：示例");
});

test("preserves paragraph boundaries and inline emphasis from WeChat HTML", () => {
  const markdown = htmlToMarkdown(`
    <section>
      <p>当前竞争形成两种模式。</p>
      <p>注：以国家作为 <span><strong>组织</strong></span> 分类维度，
        <span>公司</span> 维度也存在差别。</p>
      <p>训练推动 <span><b>模式</b></span> ——美国模式</p>
    </section>
  `, "https://mp.weixin.qq.com/s/example");

  assert.equal(markdown, [
    "当前竞争形成两种模式。",
    "",
    "注：以国家作为**组织**分类维度，公司维度也存在差别。",
    "",
    "训练推动**模式** ——美国模式"
  ].join("\n"));
  assert.doesNotMatch(markdown, / {2,}/);
});

test("keeps code indentation while normalizing prose", () => {
  const markdown = normalizeMarkdownPreservingCode(`
段落      内容

\`\`\`
const value = {
    nested: true
};
\`\`\`
`);

  assert.match(markdown, /^段落内容/);
  assert.match(markdown, /\n    nested: true\n/);
});

test("renders media and lists as independent blocks", () => {
  const markdown = htmlToMarkdown(`
    <p>第一段</p>
    <p><img data-src="/image.png" alt="示意图"></p>
    <ol><li>第一项</li><li><strong>第二项</strong></li></ol>
  `, "https://example.com/article");

  assert.match(markdown, /第一段\n\n!\[示意图\]\(https:\/\/example\.com\/image\.png\)/);
  assert.match(markdown, /1\. 第一项\n2\. \*\*第二项\*\*/);
});

test("selects the complete nested WeChat content container", () => {
  const content = selectContentHtml(`
    <html><body>
      <div id="js_content">
        <div><p>嵌套段落</p></div>
        <p>末尾段落</p>
      </div>
      <footer>噪声</footer>
    </body></html>
  `, ["#js_content"]);

  assert.match(content, /嵌套段落/);
  assert.match(content, /末尾段落/);
  assert.doesNotMatch(content, /噪声/);
});

test("preserves a WeChat comparison table instead of flattening its cells", () => {
  const markdown = htmlToMarkdown(`
    <table>
      <thead><tr><th>产品</th><th>核心策略</th><th>一句话概括</th></tr></thead>
      <tbody>
        <tr><td>Claude Code</td><td>五段流水线</td><td>LLM 摘要兜底</td></tr>
        <tr><td>Codex CLI</td><td>保留近期用户消息原文</td><td>模型回复可以重写</td></tr>
      </tbody>
    </table>
  `, "https://mp.weixin.qq.com/s/example");

  assert.match(markdown, /^\| 产品 \| 核心策略 \| 一句话概括 \|/m);
  assert.match(markdown, /^\| --- \| --- \| --- \|/m);
  assert.match(markdown, /^\| Codex CLI \| 保留近期用户消息原文 \| 模型回复可以重写 \|/m);
  assert.equal(markdownMetrics(markdown).tables, 1);
});

test("preserves headings through level six and nested ordered lists", () => {
  const markdown = htmlToMarkdown(`
    <h2>第二部分</h2>
    <h4>2.1 子章节</h4>
    <ol>
      <li>第一项<ul><li>嵌套项目</li></ul></li>
      <li>第二项</li>
    </ol>
  `);

  assert.match(markdown, /^## 第二部分$/m);
  assert.match(markdown, /^#### 2\.1 子章节$/m);
  assert.match(markdown, /^1\. 第一项$/m);
  assert.match(markdown, /^  - 嵌套项目$/m);
  assert.match(markdown, /^2\. 第二项$/m);
});

test("discovers picture sources, lazy images and CSS background images in source order", () => {
  const capture = htmlToSemanticCapture(`
    <picture>
      <source srcset="/small.webp 480w, /large.webp 1200w">
      <img src="/fallback.png" alt="流程图" width="1200" height="800">
    </picture>
    <section style="background-image:url('/diagram.png')"></section>
    <img data-lazy-src="/lazy.png" alt="延迟图片">
  `, "https://mp.weixin.qq.com/s/example");

  assert.deepEqual(capture.media.map((item) => item.url), [
    "https://mp.weixin.qq.com/large.webp",
    "https://mp.weixin.qq.com/diagram.png",
    "https://mp.weixin.qq.com/lazy.png"
  ]);
  assert.equal(capture.metrics.source.images, 3);
  assert.equal(capture.metrics.output.images, 3);
  assert.match(capture.markdown, /!\[流程图\]\(https:\/\/mp\.weixin\.qq\.com\/large\.webp\)/);
});

test("does not collapse indentation in nested Markdown lists", () => {
  const markdown = normalizeMarkdownPreservingCode(`
1. 第一项
  - 子项 A
  - 子项 B
2. 第二项
  `);
  assert.match(markdown, /^  - 子项 A$/m);
  assert.match(markdown, /^  - 子项 B$/m);
});
