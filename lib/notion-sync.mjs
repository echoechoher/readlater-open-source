const NOTION_API_BASE_URL = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2026-03-11";

export function normalizeNotionPageId(value = "") {
  const decoded = decodeURIComponent(String(value || "").trim());
  const compactMatches = decoded.match(/[0-9a-f]{32}/gi) || [];
  const uuidMatches = decoded.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
  const compact = (uuidMatches.at(-1) || compactMatches.at(-1) || "").replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return "";
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20)
  ].join("-");
}

function notionErrorMessage(status, data = {}) {
  const detail = data?.message || data?.error || "Unknown Notion API error";
  if (status === 401) return "Notion Token 无效或已经失效";
  if (status === 403) return "Notion Integration 没有写入目标页面的权限";
  if (status === 404) return "Notion 目标页面不存在，或尚未通过 Add connections 分享给 Integration";
  if (status === 429) return "Notion 请求过于频繁，请稍后重试";
  return `Notion API HTTP ${status}: ${detail}`;
}

async function notionRequest(path, { token, method = "GET", body, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!token) throw new Error("Notion Token 未配置");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${NOTION_API_BASE_URL}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_API_VERSION
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Notion 请求超时");
    throw new Error(`无法连接 Notion：${error?.message || "network error"}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text.slice(0, 500) };
    }
  }
  if (!response.ok) throw new Error(notionErrorMessage(response.status, data));
  return data;
}

function pageTitle(page = {}) {
  for (const property of Object.values(page.properties || {})) {
    const title = property?.title?.map((part) => part?.plain_text || part?.text?.content || "").join("").trim();
    if (title) return title;
  }
  return "Notion 页面";
}

export async function validateNotionConnection({ token, parentPageId, fetchImpl = fetch } = {}) {
  const pageId = normalizeNotionPageId(parentPageId);
  if (!pageId) throw new Error("Notion 父页面 ID 或 URL 格式不正确");
  const page = await notionRequest(`/pages/${pageId}`, { token, fetchImpl });
  return {
    pageId,
    pageTitle: pageTitle(page),
    pageUrl: page.url || ""
  };
}

function withoutManualSyncDisclaimer(content = "") {
  return String(content || "")
    .split("\n")
    .filter((line) => !/(尚未实际写入|尚未写入 Notion|需要你手动复制|需要你手动沉淀)/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sourceMarkdown(article = {}) {
  const title = String(article.title || article.url || "原文").replace(/[\[\]]/g, "");
  return article.url ? `[${title}](${article.url})` : title;
}

function inlineBreaks(value = "") {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^([ \t]*[●•▪◦])(?:[ \t]*\n)+[ \t]*/u, "$1 ")
    .split("\n")
    .join("<br>");
}

function entryTitle(value = "", fallback = "未命名认知") {
  const title = String(value || "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  return title || fallback;
}

export function buildNotionEntryMarkdown(article = {}, route = {}) {
  const sections = [`### ${entryTitle(route.title, article.title || "未命名认知")}`];
  const highlights = article.highlights || [];
  if (highlights.length) {
    const annotations = highlights.map((highlight) => {
      const parts = [`> ${inlineBreaks(highlight.selectedText || "")}`];
      if (highlight.note) parts.push(`*我的想法：${inlineBreaks(highlight.note)}*`);
      return parts.join("\n");
    }).join("\n");
    sections.push(`**标注：**\n${annotations}`);
  }

  const discussion = withoutManualSyncDisclaimer(route.discussion || "");
  if (discussion) sections.push(`**讨论：**\n${discussion}`);
  sections.push(`← ${sourceMarkdown(article)}`);
  sections.push("---");
  return sections.join("\n").trim();
}

export async function appendNotionPage({
  token,
  pageId,
  markdown,
  fetchImpl = fetch
} = {}) {
  const normalizedPageId = normalizeNotionPageId(pageId);
  if (!normalizedPageId) throw new Error("Notion 目标页面 ID 或 URL 格式不正确");
  if (!markdown?.trim()) throw new Error("没有可追加到 Notion 的内容");
  await notionRequest(`/pages/${normalizedPageId}/markdown`, {
    token,
    method: "PATCH",
    fetchImpl,
    body: {
      type: "insert_content",
      insert_content: {
        content: markdown,
        position: { type: "end" }
      }
    }
  });
  return {
    pageId: normalizedPageId,
    pageUrl: `https://www.notion.so/${normalizedPageId.replaceAll("-", "")}`
  };
}
