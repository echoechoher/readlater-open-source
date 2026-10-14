import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("Inbox import uses a plus trigger and an accessible modal", () => {
  assert.match(appSource, /id="open-import-dialog"/);
  assert.match(appSource, /aria-label="导入文章或播客"/);
  assert.match(appSource, /role="dialog" aria-modal="true" aria-labelledby="import-dialog-title"/);
  assert.match(appSource, /粘贴文章或播客链接，系统会自动识别内容类型/);
  assert.doesNotMatch(appSource, /class="sidebar-import-form"/);
  assert.match(appSource, /class="sidebar-status" role="status"/);
});

test("import modal retains URL drafts, reports progress, and supports keyboard dismissal", () => {
  assert.match(appSource, /value="\$\{escapeHtml\(state\.importUrlDraft\)\}"/);
  assert.match(appSource, /state\.importStatus = "正在识别链接并导入\.\.\."/);
  assert.match(appSource, /if \(state\.importDialogOpen\) \{\s*closeImportDialog\(\)/);
  assert.match(appSource, /state\.importDialogOpen = false;\s*state\.importStatus = "";/);
});

test("import modal has responsive styling and cache-busted assets", () => {
  assert.match(stylesSource, /\.dialog-backdrop\s*\{/);
  assert.match(stylesSource, /\.import-dialog\s*\{/);
  assert.match(stylesSource, /@media \(max-width: 760px\)[\s\S]*\.dialog-backdrop\s*\{/);
  assert.match(indexSource, /styles\.css\?v=20261014-import-dialog-1/);
  assert.match(indexSource, /app\.js\?v=20261014-import-dialog-1/);
});
