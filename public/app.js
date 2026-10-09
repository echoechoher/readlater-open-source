import { DIGEST_ACTIONS, DIGEST_MODE_LABELS } from "./digest-config.js?v=20260907-resizable-panel";
import {
  anchorFromRange,
  applyTextAnchorMark,
  unwrapMarks
} from "./highlight-anchors.js?v=20261003-range-anchors-10";

const AI_PROVIDER_STORAGE_KEY = "readlater_ai_provider";
const SIDE_PANEL_WIDTH_STORAGE_KEY = "readlater_side_panel_width";
const DEFAULT_SIDE_PANEL_WIDTH = 312;
const MIN_SIDE_PANEL_WIDTH = 240;
const MIN_READER_WIDTH = 280;
const NOTION_DESTINATION_TEMPLATES = [
  ["agent-product", "Agent 产品范式", "AI 产品形态、入口分发、Skill/Agent 架构与任务系统"],
  ["moat-competition", "护城河与竞争", "竞争壁垒、memory 复利、平台与应用层、商业模式"],
  ["product-methodology", "产品方法论", "需求发现、dogfooding、评测、PM 方法"],
  ["knowledge-management", "知识与认知管理", "知识沉淀、输出习惯、个人知识体系与认知管理"]
];
const AI_PROVIDERS = {
  openai_compatible: "OpenAI-compatible provider"
};

function normalizeAiProvider(value = "") {
  return Object.prototype.hasOwnProperty.call(AI_PROVIDERS, value) ? value : "openai_compatible";
}

function savedAiProvider() {
  try {
    return normalizeAiProvider(localStorage.getItem(AI_PROVIDER_STORAGE_KEY));
  } catch {
    return "openai_compatible";
  }
}

function savedSidePanelWidth() {
  try {
    const width = Number(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY));
    return Number.isFinite(width) && width >= MIN_SIDE_PANEL_WIDTH
      ? width
      : DEFAULT_SIDE_PANEL_WIDTH;
  } catch {
    return DEFAULT_SIDE_PANEL_WIDTH;
  }
}

const state = {
  articles: [],
  activeArticle: null,
  selectedText: "",
  selectionPrefix: "",
  selectionSuffix: "",
  selectionStart: null,
  selectionEnd: null,
  editingComment: null,
  openCommentMenuId: "",
  articleMenu: null,
  sideTab: "comment",
  settings: null,
  listMode: "inbox",
  sidebarCollapsed: false,
  sidePanelWidth: savedSidePanelWidth(),
  showTranslation: false,
  loading: false,
  polling: false,
  notionSaving: false,
  status: "",
  aiProvider: savedAiProvider(),
  authRequired: false,
  authenticated: true
};

let lastReaderScrollTop = 0;
const translationCache = {};

const app = document.querySelector("#app");

function isMobileLayout() {
  return window.matchMedia?.("(max-width: 760px)").matches || false;
}

function sidePanelWidthBounds() {
  const main = document.querySelector(".main");
  const mainWidth = main?.getBoundingClientRect().width || DEFAULT_SIDE_PANEL_WIDTH + MIN_READER_WIDTH;
  return {
    min: MIN_SIDE_PANEL_WIDTH,
    max: Math.max(MIN_SIDE_PANEL_WIDTH, Math.round(mainWidth - MIN_READER_WIDTH))
  };
}

function setSidePanelWidth(nextWidth, { persist = false } = {}) {
  const bounds = sidePanelWidthBounds();
  const width = Math.round(Math.min(bounds.max, Math.max(bounds.min, Number(nextWidth) || DEFAULT_SIDE_PANEL_WIDTH)));
  state.sidePanelWidth = width;
  document.querySelector(".main")?.style.setProperty("--side-panel-width", `${width}px`);
  const resizer = document.querySelector("[data-side-panel-resizer]");
  resizer?.setAttribute("aria-valuenow", String(width));
  resizer?.setAttribute("aria-valuemax", String(bounds.max));
  resizer?.setAttribute("aria-valuetext", `${width} 像素`);
  if (persist) {
    try {
      localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(width));
    } catch {
      // The current width still works when storage is unavailable.
    }
  }
  return width;
}

function bindSidePanelResizer() {
  const resizer = document.querySelector("[data-side-panel-resizer]");
  const main = document.querySelector(".main");
  if (!resizer || !main) return;

  const stopDragging = () => {
    document.body.classList.remove("resizing-side-panel");
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopDragging);
    window.removeEventListener("pointercancel", stopDragging);
    setSidePanelWidth(state.sidePanelWidth, { persist: true });
  };
  const handlePointerMove = (event) => {
    setSidePanelWidth(main.getBoundingClientRect().right - event.clientX);
  };

  resizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia?.("(max-width: 1080px)").matches) return;
    event.preventDefault();
    document.body.classList.add("resizing-side-panel");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging, { once: true });
    window.addEventListener("pointercancel", stopDragging, { once: true });
  });
  resizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.shiftKey ? 40 : 10;
    setSidePanelWidth(
      state.sidePanelWidth + (event.key === "ArrowLeft" ? delta : -delta),
      { persist: true }
    );
  });
  resizer.addEventListener("dblclick", () => {
    setSidePanelWidth(DEFAULT_SIDE_PANEL_WIDTH, { persist: true });
  });
  setSidePanelWidth(state.sidePanelWidth);
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function closestElement(target, selector) {
  const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  return element?.closest?.(selector) || null;
}

function isDecorativeMediaUrl(url = "", alt = "") {
  const value = `${url} ${alt}`.toLowerCase();
  return /(trans_?1x1|spacer|blank\.gif|pixel|tracking|transparent)/i.test(value);
}

function trimKnownTailNoise(value = "") {
  const markers = [
    "\nProduct updates, how-tos, community spotlights",
    "\nDelivered monthly to your inbox",
    "\nDeveloper newsletter",
    "\nContinue reading",
    "\nRelated articles",
    "\nMore from",
    "\n继续阅读",
    "\n相关文章",
    "\n查看全部",
    "\n订阅"
  ];
  let result = String(value || "");
  markers.forEach((marker) => {
    const index = result.toLowerCase().indexOf(marker.toLowerCase());
    if (index > 800) result = result.slice(0, index).trim();
  });
  return result;
}

function normalizeProseSpacing(value = "") {
  return String(value || "")
    .replace(/\u00a0|\u3000/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/(\p{Script=Han}) +(?=\p{Script=Han})/gu, "$1")
    .replace(/(\p{Script=Han}) +(\*\*|\*)(?=\p{Script=Han})/gu, "$1$2")
    .replace(/(\p{Script=Han})(\*\*|\*) +(?=\p{Script=Han})/gu, "$1$2")
    .replace(/ +([，。！？；：、）》】」』〕〉…])/gu, "$1")
    .replace(/([，。！？；：、）》】」』〕〉…]) +(?=\p{Script=Han})/gu, "$1")
    .replace(/([（《【「『〔〈]) +/gu, "$1");
}

function normalizeMarkdownForDisplay(value = "") {
  const source = String(value || "").replaceAll("\r\n", "\n");
  const parts = [];
  let cursor = 0;
  for (const match of source.matchAll(/```[\s\S]*?```/g)) {
    const before = source.slice(cursor, match.index).split("\n").map((line) => {
      const list = line.match(/^(\s*)((?:[-+*]|\d+\.)\s+)(.*)$/u);
      if (list) return `${list[1].replace(/\t/g, "  ")}${list[2]}${normalizeProseSpacing(list[3]).trim()}`;
      return normalizeProseSpacing(line).trim();
    }).join("\n");
    if (before) parts.push(before);
    parts.push(match[0]);
    cursor = match.index + match[0].length;
  }
  const rest = source.slice(cursor).split("\n").map((line) => {
    const list = line.match(/^(\s*)((?:[-+*]|\d+\.)\s+)(.*)$/u);
    if (list) return `${list[1].replace(/\t/g, "  ")}${list[2]}${normalizeProseSpacing(list[3]).trim()}`;
    return normalizeProseSpacing(line).trim();
  }).join("\n");
  if (rest) parts.push(rest);
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderInlineMarkdown(value = "") {
  return escapeHtml(value)
    .replace(/!\[([^\]]*)\]\(((?:https?:\/\/|\/media\/)[^)\s]+)\)/g, (_, alt, url) => (
      isDecorativeMediaUrl(url, alt)
        ? ""
        : `<img src="${url}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
    ))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderNestedList(items = []) {
  const roots = [];
  const stack = [];
  items.forEach((item) => {
    const depth = Math.min(Math.max(0, item.depth), stack.length);
    const node = { ...item, children: [] };
    if (depth === 0) roots.push(node);
    else stack[depth - 1].children.push(node);
    stack[depth] = node;
    stack.length = depth + 1;
  });

  const renderSiblings = (nodes) => {
    let output = "";
    let index = 0;
    while (index < nodes.length) {
      const ordered = nodes[index].ordered;
      const group = [];
      while (index < nodes.length && nodes[index].ordered === ordered) {
        group.push(nodes[index]);
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      output += `<${tag}>${group.map((node) => (
        `<li>${renderInlineMarkdown(node.content)}${node.children.length ? renderSiblings(node.children) : ""}</li>`
      )).join("")}</${tag}>`;
    }
    return output;
  };
  return renderSiblings(roots);
}

function markdownTableCells(line = "") {
  const source = line.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      cell += character === "|" ? "|" : `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function renderMarkdown(value = "") {
  const lines = String(value).replaceAll("\r\n", "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listItems = [];
  let listType = "";
  let tableRows = [];
  let quoteLines = [];
  let inCode = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    html.push(renderNestedList(listItems));
    listItems = [];
    listType = "";
  };
  const flushQuote = () => {
    if (!quoteLines.length) return;
    html.push(`<blockquote>${quoteLines.map(renderInlineMarkdown).join("<br>")}</blockquote>`);
    quoteLines = [];
  };
  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows.map(markdownTableCells);
    const dividerIndex = rows.findIndex((row) => row.every((cell) => /^:?-{3,}:?$/.test(cell)));
    const header = dividerIndex > 0 ? rows[0] : [];
    const body = dividerIndex > 0 ? rows.filter((_, index) => index !== 0 && index !== dividerIndex) : rows;
    html.push(`
      <table>
        ${header.length ? `<thead><tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>` : ""}
        <tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    `);
    tableRows = [];
  };

  lines.forEach((line) => {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        flushQuote();
        flushTable();
        inCode = true;
      }
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      flushTable();
      return;
    }

    if (/^\|.*\|$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushQuote();
      tableRows.push(trimmed);
      return;
    }

    flushTable();

    const image = trimmed.match(/^!\[([^\]]*)\]\(((?:https?:\/\/|\/media\/)[^)\s]+)\)$/);
    if (image) {
      flushParagraph();
      flushList();
      flushQuote();
      if (!isDecorativeMediaUrl(image[2], image[1])) {
        html.push(`<figure><img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />${image[1] ? `<figcaption>${escapeHtml(image[1])}</figcaption>` : ""}</figure>`);
      }
      return;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push("<hr>");
      return;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      return;
    }

    const list = line.match(/^(\s*)((?:[-+*])|(\d+)\.)\s+(.+)$/);
    if (list) {
      flushParagraph();
      flushQuote();
      const depth = Math.floor(list[1].replace(/\t/g, "  ").length / 2);
      listItems.push({ depth, ordered: Boolean(list[3]), content: list[4] });
      return;
    }

    const quote = trimmed.match(/^>\s+(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      return;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  });

  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  flushQuote();
  flushTable();
  return html.join("");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function formatPublishedDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(date);
}

function readingTime(article) {
  const length = (article?.contentText || "").replace(/\s+/g, "").length;
  return length ? `${Math.max(1, Math.ceil(length / 500))} 分钟阅读` : "";
}

function renderReaderMeta(article) {
  const parts = [
    article.author,
    article.siteName,
    formatPublishedDate(article.publishedAt),
    readingTime(article)
  ].filter(Boolean);
  if (!parts.length) return "";
  return `<div class="reader-meta">${parts.map((part) => `<span>${escapeHtml(part)}</span>`).join("")}</div>`;
}

function errorMessage(error) {
  const message = error?.message || "请求失败";
  return {
    "Authentication required": "请先登录",
    "Wrong password": "密码不正确",
    "Request failed": "请求失败",
    "Save failed": "保存失败"
  }[message] || message;
}

function sourceType(article = {}) {
  const value = [
    article.siteName,
    article.source,
    article.extractionMethod,
    article.url
  ].join(" ").toLowerCase();
  if (value.includes("wechat") || value.includes("weixin") || value.includes("mp.weixin.qq.com")) return "wechat";
  if (value.includes("x.com") || value.includes("twitter") || value.includes("captured_x")) return "x";
  if (value.includes("jike") || value.includes("okjike.com") || value.includes("即刻")) return "jike";
  return "web";
}

function sourceIcon(article) {
  const type = sourceType(article);
  const label = { wechat: "微信公众号", x: "X", jike: "即刻", web: "网页" }[type];
  return `<span class="source-icon ${type}" title="${label}" aria-label="${label}"></span>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (response.status === 401) {
    state.authRequired = true;
    state.authenticated = false;
  }
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function loadSession() {
  const data = await api("/api/auth/session");
  state.authRequired = data.authRequired;
  state.authenticated = data.authenticated;
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const password = form.querySelector("input")?.value || "";
  state.loading = true;
  state.status = "正在登录...";
  render();
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password })
    });
    state.authenticated = true;
    state.status = "";
    await Promise.all([loadArticles(), loadSettings()]);
  } catch (error) {
    state.status = errorMessage(error);
    render();
  } finally {
    state.loading = false;
    render();
  }
}

async function loadArticles() {
  const data = await api("/api/articles");
  state.articles = data.articles;
  const visible = visibleArticles();
  const activeVisible = visible.some((article) => article.id === state.activeArticle?.id);
  if (!activeVisible) state.activeArticle = null;
  render();
  if (!state.activeArticle && visible.length) {
    loadArticle(visible[0].id);
  }
}

async function loadSettings() {
  const data = await api("/api/settings");
  state.settings = data.settings;
  render();
}

async function loadArticle(id) {
  state.activeArticle = null;
  state.selectedText = "";
  state.selectionPrefix = "";
  state.selectionSuffix = "";
  state.selectionStart = null;
  state.selectionEnd = null;
  state.editingComment = null;
  state.openCommentMenuId = "";
  state.articleMenu = null;
  state.loading = true;
  lastReaderScrollTop = 0;
  removeTranslationLines();
  renderArticleView();
  const data = await api(`/api/articles/${id}`);
  state.activeArticle = data.article;
  if (isMobileLayout()) state.sidebarCollapsed = true;
  state.loading = false;
  if (data.article.translations?.zh) {
    translationCache[data.article.id] = { ...translationCache[data.article.id], ...data.article.translations.zh };
  }
  renderArticleView();
  if (state.showTranslation) applyTranslation();
}

function visibleArticles() {
  if (state.listMode === "setup") return [];
  return state.articles.filter((article) => {
    const readingStatus = article.readingStatus || "inbox";
    return state.listMode === "archive" ? readingStatus === "archived" : readingStatus !== "archived";
  });
}

async function setArticleReadingStatus(articleId, readingStatus) {
  const data = await api(`/api/articles/${articleId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ readingStatus })
  });
  state.articles = state.articles.map((article) => (
    article.id === articleId ? { ...article, ...data.article } : article
  ));
  if (state.activeArticle?.id === articleId) {
    state.activeArticle = { ...state.activeArticle, ...data.article };
  }
  const visible = visibleArticles();
  const activeVisible = visible.some((article) => article.id === state.activeArticle?.id);
  if (!activeVisible) {
    state.activeArticle = null;
    if (visible.length) await loadArticle(visible[0].id);
  }
  render();
}

async function toggleArchiveActiveArticle() {
  if (!state.activeArticle) return;
  const currentStatus = state.activeArticle.readingStatus || "inbox";
  await setArticleReadingStatus(
    state.activeArticle.id,
    currentStatus === "archived" ? "inbox" : "archived"
  );
}

async function refetchActiveArticle() {
  if (!state.activeArticle || state.loading) return;
  state.loading = true;
  state.status = "正在重新抓取...";
  renderPreservingReaderScroll();
  try {
    const data = await api(`/api/articles/${state.activeArticle.id}/refetch`, {
      method: "POST",
      body: JSON.stringify({})
    });
    state.articles = state.articles.map((article) => (
      article.id === data.article.id ? { ...article, ...data.article } : article
    ));
    await loadArticle(data.article.id);
    state.status = data.article.fetchStatus === "failed" ? "还是没有抓到正文。" : "已重新抓取。";
  } catch (error) {
    state.status = errorMessage(error);
    renderPreservingReaderScroll();
  } finally {
    state.loading = false;
    renderPreservingReaderScroll();
  }
}

async function refreshActiveArticle() {
  if (!state.activeArticle) return;
  const data = await api(`/api/articles/${state.activeArticle.id}`);
  state.activeArticle = data.article;
  render();
}

async function pollDigestJobs() {
  if (
    state.polling
    || state.sideTab !== "ai"
    || !state.activeArticle
    || !hasRunningDigestJob(state.activeArticle)
  ) return;
  state.polling = true;
  try {
    await refreshActiveArticle();
  } catch {
    // Polling is best-effort; explicit user actions still surface errors.
  } finally {
    state.polling = false;
  }
}

async function createDigestJob(mode, instruction) {
  if (!state.activeArticle) return;
  const data = await api(`/api/articles/${state.activeArticle.id}/digest-jobs`, {
    method: "POST",
    body: JSON.stringify({ mode, instruction, provider: state.aiProvider })
  });
  state.activeArticle = data.article;
  state.sideTab = "ai";
  render();
}

function setAiProvider(provider) {
  state.aiProvider = normalizeAiProvider(provider);
  try {
    localStorage.setItem(AI_PROVIDER_STORAGE_KEY, state.aiProvider);
  } catch {
    // Local storage is only a convenience; the current session state is enough.
  }
  renderPreservingReaderScroll();
}

async function saveNotionSettings(event) {
  event.preventDefault();
  if (state.notionSaving) return;
  const form = event.currentTarget;
  const token = form.elements.namedItem("notionToken")?.value.trim() || "";
  const parentPageId = form.elements.namedItem("notionParentPage")?.value.trim() || "";
  const destinations = NOTION_DESTINATION_TEMPLATES.map(([key, name, description]) => ({
    key, name, description,
    pageId: form.elements.namedItem(`notionDestination_${key}`)?.value.trim() || ""
  })).filter((item) => item.pageId);
  state.notionSaving = true;
  state.status = "正在验证 Notion 连接...";
  render();
  try {
    const data = await api("/api/settings/notion", {
      method: "PUT",
      body: JSON.stringify({ token, parentPageId, destinations })
    });
    state.settings = data.settings;
    state.status = `Notion 已连接：${data.settings.notion.parentPageTitle || "目标页面"}`;
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    state.notionSaving = false;
    render();
  }
}

async function continueDigestDiscussion() {
  const textarea = document.querySelector("#ai-input");
  const message = textarea?.value.trim() || "";
  if (!message) return;
  await createDigestJob("discussion", message);
}

async function importUrl(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.querySelector("input");
  const url = input.value.trim();
  if (!url) return;
  state.loading = true;
  state.status = "正在抓取文章...";
  render();
  try {
    const data = await api("/api/inbox/url", {
      method: "POST",
      body: JSON.stringify({ url, source: "paste_url" })
    });
    input.value = "";
    state.status = data.duplicate ? "已经保存过了。" : "已保存到收件箱。";
    await loadArticles();
    await loadArticle(data.article.id);
  } catch (error) {
    state.status = errorMessage(error);
    render();
  } finally {
    state.loading = false;
    render();
  }
}

function readerScrollTop() {
  return document.querySelector(".reader")?.scrollTop || 0;
}

function articleListScrollTop() {
  return document.querySelector(".article-list")?.scrollTop || 0;
}

function restoreReaderScrollTop(scrollTop) {
  const nextReader = document.querySelector(".reader");
  if (nextReader) nextReader.scrollTop = scrollTop;
}

function restoreArticleListScrollTop(scrollTop) {
  const nextList = document.querySelector(".article-list");
  if (nextList) nextList.scrollTop = scrollTop;
}

function readerViewportAnchor() {
  const reader = document.querySelector(".reader");
  const content = document.querySelector(".content");
  if (!reader || !content) return null;
  const readerRect = reader.getBoundingClientRect();
  const blocks = [...content.querySelectorAll("p, li, blockquote, h3, h4, h5")]
    .filter((block) => !block.closest(".translation-line"));
  const targetTop = readerRect.top + 72;
  const block = blocks.find((candidate) => candidate.getBoundingClientRect().bottom >= targetTop)
    || blocks[0];
  if (!block) return null;
  const text = block.textContent.trim();
  if (!text) return null;
  return {
    key: translationCacheKey(text),
    offset: block.getBoundingClientRect().top - readerRect.top,
    scrollTop: reader.scrollTop
  };
}

function restoreReaderViewportAnchor(anchor) {
  if (!anchor) return false;
  const reader = document.querySelector(".reader");
  const content = document.querySelector(".content");
  if (!reader || !content) return false;
  const block = [...content.querySelectorAll("p, li, blockquote, h3, h4, h5")]
    .filter((candidate) => !candidate.closest(".translation-line"))
    .find((candidate) => translationCacheKey(candidate.textContent.trim()) === anchor.key);
  if (!block) {
    restoreReaderScrollTop(anchor.scrollTop || 0);
    return false;
  }
  const readerRect = reader.getBoundingClientRect();
  const delta = block.getBoundingClientRect().top - readerRect.top - anchor.offset;
  reader.scrollTop += delta;
  return true;
}

function renderPreservingReaderScroll() {
  const anchor = readerViewportAnchor();
  const scrollTop = readerScrollTop();
  render();
  const restore = () => {
    if (!restoreReaderViewportAnchor(anchor)) restoreReaderScrollTop(scrollTop);
  };
  if (state.showTranslation && state.activeArticle) {
    const translation = applyTranslation();
    restore();
    requestAnimationFrame(restore);
    translation?.finally?.(() => requestAnimationFrame(restore));
    return;
  }
  restore();
}

function selectionBelongsToContent(selection) {
  if (!selection || !selection.rangeCount) return false;
  const content = document.querySelector(".content");
  if (!content) return false;
  const range = selection.getRangeAt(0);
  const belongsToTranslation = (node) => {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest?.(".translation-line"));
  };
  return content.contains(range.commonAncestorContainer)
    && !belongsToTranslation(range.startContainer)
    && !belongsToTranslation(range.endContainer)
    && ![...content.querySelectorAll(".translation-line")].some((line) => range.intersectsNode(line));
}

function removeActiveSelectionMark() {
  globalThis.CSS?.highlights?.delete("readlater-active-selection");
  unwrapMarks(document.querySelector(".content"), "mark.active-selection");
}

function applyActiveSelectionMark(range, anchor) {
  const content = document.querySelector(".content");
  if (!content || !range || !anchor) return;
  if (globalThis.CSS?.highlights && typeof globalThis.Highlight === "function") {
    globalThis.CSS.highlights.set("readlater-active-selection", new globalThis.Highlight(range));
    return;
  }
  // Some browsers finalize their native Selection after the mouseup handler,
  // and background tabs may throttle animation frames. A new task runs after
  // finalization in both foreground and background tabs.
  window.setTimeout(() => {
    if (
      state.selectionStart !== anchor.textStart
      || state.selectionEnd !== anchor.textEnd
      || state.selectedText !== anchor.selectedText
    ) return;
    window.getSelection()?.removeAllRanges();
    applyTextAnchorMark(content, anchor, { className: "active-selection" });
  }, 0);
}

function updateSidePanelForSelection() {
  const sidePanel = document.querySelector(".side-panel");
  if (!sidePanel) return;
  sidePanel.outerHTML = renderSidePanel();
  bindSidePanelHandlers();
}

function ensureFallbackSelectionMark() {
  if (
    !state.selectedText
    || (globalThis.CSS?.highlights && typeof globalThis.Highlight === "function")
    || document.querySelector("mark.active-selection")
  ) return;
  applyTextAnchorMark(document.querySelector(".content"), {
    anchorVersion: 2,
    selectedText: state.selectedText,
    prefix: state.selectionPrefix,
    suffix: state.selectionSuffix,
    textStart: state.selectionStart,
    textEnd: state.selectionEnd
  }, { className: "active-selection" });
}

function captureSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !state.activeArticle || !selectionBelongsToContent(selection)) return;
  const content = document.querySelector(".content");
  const range = selection.getRangeAt(0).cloneRange();
  const anchor = anchorFromRange(content, range);
  if (!anchor?.selectedText) return;
  if (
    state.selectionStart === anchor.textStart
    && state.selectionEnd === anchor.textEnd
    && state.selectedText === anchor.selectedText
  ) return;
  state.selectedText = anchor.selectedText;
  state.selectionPrefix = anchor.prefix;
  state.selectionSuffix = anchor.suffix;
  state.selectionStart = anchor.textStart;
  state.selectionEnd = anchor.textEnd;
  state.editingComment = null;
  state.openCommentMenuId = "";
  removeActiveSelectionMark();
  applyActiveSelectionMark(range, anchor);
  updateSidePanelForSelection();
}

function clearTransientSelection() {
  if (!state.selectedText) return;
  state.selectedText = "";
  state.selectionPrefix = "";
  state.selectionSuffix = "";
  state.selectionStart = null;
  state.selectionEnd = null;
  removeActiveSelectionMark();
  updateSidePanelForSelection();
}

function handleDocumentMouseUp(event) {
  const endedInReader = Boolean(closestElement(event.target, ".reader"));
  window.setTimeout(() => {
    const selection = window.getSelection();
    if (selection?.toString().trim() && selectionBelongsToContent(selection)) {
      captureSelection();
      return;
    }
    if (endedInReader) clearTransientSelection();
  }, 0);
}

function handleDocumentCopy(event) {
  if (!state.selectedText) return;
  event.clipboardData?.setData("text/plain", state.selectedText);
  event.preventDefault();
}

function handleReaderScroll(event) {
  lastReaderScrollTop = event.currentTarget?.scrollTop || 0;
}

function handleTopbarWheel(event) {
  const reader = document.querySelector(".reader");
  if (!reader) return;
  event.preventDefault();
  reader.scrollBy({ top: event.deltaY, left: 0 });
}

async function saveHighlight(noteOverride) {
  if (!state.activeArticle || !state.selectedText) return;
  const textarea = document.querySelector("#comment-input");
  const note = noteOverride ?? textarea?.value ?? "";
  const pendingAnchor = {
    anchorVersion: 2,
    selectedText: state.selectedText,
    prefix: state.selectionPrefix,
    suffix: state.selectionSuffix,
    textStart: state.selectionStart,
    textEnd: state.selectionEnd
  };
  const data = await api(`/api/articles/${state.activeArticle.id}/highlights`, {
    method: "POST",
    body: JSON.stringify({
      ...pendingAnchor,
      color: "yellow",
      note
    })
  });
  state.activeArticle.highlights ||= [];
  state.activeArticle.highlights.push(data.highlight);
  removeActiveSelectionMark();
  window.getSelection()?.removeAllRanges();
  state.selectedText = "";
  state.selectionPrefix = "";
  state.selectionSuffix = "";
  state.selectionStart = null;
  state.selectionEnd = null;
  if (textarea) textarea.value = "";
  applyTextAnchorMark(document.querySelector(".content"), data.highlight, {
    className: "saved-highlight",
    highlightId: data.highlight.id
  });
  updateSidePanelForSelection();
}

async function saveHighlightNote(id, value) {
  return api(`/api/highlights/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ note: value })
  });
}

async function saveEditedComment() {
  if (!state.activeArticle || !state.editingComment) return;
  const textarea = document.querySelector(`[data-edit-comment-input-id="${state.editingComment.id}"]`);
  const value = textarea?.value.trim() || "";
  if (!value) return;

  const { type, id } = state.editingComment;
  if (type === "highlight") {
    const data = await saveHighlightNote(id, value);
    state.activeArticle.highlights = (state.activeArticle.highlights || []).map((entry) => (
      entry.id === id ? { ...entry, ...data.highlight } : entry
    ));
  } else {
    const data = await api(`/api/notes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: value })
    });
    state.activeArticle.notes = (state.activeArticle.notes || []).map((entry) => (
      entry.id === id ? { ...entry, ...data.note } : entry
    ));
  }

  state.editingComment = null;
  state.openCommentMenuId = "";
  if (textarea) textarea.value = "";
  renderPreservingReaderScroll();
}

async function saveArticleNote() {
  if (!state.activeArticle) return;
  const textarea = document.querySelector("#comment-input");
  const content = textarea.value.trim();
  if (!content) return;
  const data = await api(`/api/articles/${state.activeArticle.id}/notes`, {
    method: "POST",
    body: JSON.stringify({ content })
  });
  state.activeArticle.notes ||= [];
  state.activeArticle.notes.push(data.note);
  textarea.value = "";
  renderPreservingReaderScroll();
}

async function deleteComment(type, id) {
  if (!state.activeArticle || !id) return;
  const path = type === "highlight" ? `/api/highlights/${id}` : `/api/notes/${id}`;
  await api(path, { method: "DELETE" });
  if (type === "highlight") {
    state.activeArticle.highlights = (state.activeArticle.highlights || []).filter((entry) => entry.id !== id);
    unwrapMarks(document.querySelector(".content"), `mark.saved-highlight[data-highlight-id="${CSS.escape(id)}"]`);
  } else {
    state.activeArticle.notes = (state.activeArticle.notes || []).filter((entry) => entry.id !== id);
  }
  if (state.editingComment?.id === id) state.editingComment = null;
  state.openCommentMenuId = "";
  updateSidePanelForSelection();
}

function closeArticleMenu() {
  if (!state.articleMenu) return;
  state.articleMenu = null;
  renderPreservingReaderScroll();
}

function openArticleMenu(event, articleId) {
  event.preventDefault();
  event.stopPropagation();
  const menuWidth = 104;
  const menuHeight = 42;
  state.articleMenu = {
    articleId,
    x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
    y: Math.min(event.clientY, window.innerHeight - menuHeight - 8)
  };
  renderPreservingReaderScroll();
}

async function deleteArticle(articleId) {
  if (!articleId || state.loading) return;
  state.loading = true;
  state.articleMenu = null;
  try {
    await api(`/api/articles/${articleId}`, { method: "DELETE" });
    state.articles = state.articles.filter((article) => article.id !== articleId);
    if (state.activeArticle?.id === articleId) {
      state.activeArticle = null;
      const visible = visibleArticles();
      if (visible.length) await loadArticle(visible[0].id);
    }
    state.status = "";
    render();
  } catch (error) {
    state.status = errorMessage(error);
    renderPreservingReaderScroll();
  } finally {
    state.loading = false;
    renderPreservingReaderScroll();
  }
}

function toggleCommentMenu(id) {
  state.openCommentMenuId = state.openCommentMenuId === id ? "" : id;
  renderPreservingReaderScroll();
}

function editComment(type, id) {
  const comment = articleComments(state.activeArticle).find((entry) => entry.type === type && entry.id === id);
  if (!comment) return;
  state.editingComment = { type, id };
  state.openCommentMenuId = "";
  state.selectedText = "";
  state.selectionPrefix = "";
  state.selectionSuffix = "";
  state.selectionStart = null;
  state.selectionEnd = null;
  removeActiveSelectionMark();
  renderPreservingReaderScroll();
}

function articleText(article) {
  return article.contentText || "这篇内容暂时没有抓取到可读正文，链接已经保存，可以稍后检查。";
}

function applyMarksToHtml(html, marks = []) {
  if (!marks.length) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  marks.forEach((mark) => applyTextAnchorMark(template.content, mark, {
    className: mark.type,
    highlightId: mark.id
  }));

  return template.innerHTML;
}

function articleMarks(article) {
  return (article.highlights || []).map((highlight) => ({
    ...highlight,
    text: highlight.selectedText,
    type: "saved-highlight"
  }));
}

function renderArticleContent(article) {
  if (article.contentMarkdown) {
    const markdown = normalizeMarkdownForDisplay(trimKnownTailNoise(article.contentMarkdown));
    return applyMarksToHtml(renderMarkdown(markdown), articleMarks(article));
  }

  const raw = trimKnownTailNoise(articleText(article));
  return applyMarksToHtml(escapeHtml(raw), articleMarks(article));
}

function articleComments(article) {
  const highlights = (article.highlights || []).map((highlight) => ({
    id: highlight.id,
    type: "highlight",
    quote: highlight.selectedText || "",
    body: highlight.note || "",
    createdAt: highlight.createdAt || ""
  }));
  const notes = (article.notes || []).map((note) => ({
    id: note.id,
    type: "note",
    quote: "",
    body: note.content || "",
    createdAt: note.createdAt || ""
  }));
  return [...highlights, ...notes].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderCommentList(article) {
  const comments = article ? articleComments(article) : [];
  if (!comments.length) return "";
  return `
    <div class="comment-list">
      ${comments.map((comment) => {
        const isEditing = state.editingComment?.id === comment.id && state.editingComment?.type === comment.type;
        return `
        <div class="comment-item ${state.editingComment?.id === comment.id ? "editing" : ""}">
          <button class="comment-menu-button" type="button" data-comment-menu-id="${comment.id}" aria-label="更多操作">...</button>
          ${state.openCommentMenuId === comment.id ? `
            <div class="comment-menu">
              <button type="button" data-edit-comment-type="${comment.type}" data-edit-comment-id="${comment.id}">编辑</button>
              <button type="button" data-delete-comment-type="${comment.type}" data-delete-comment-id="${comment.id}">删除</button>
            </div>
          ` : ""}
          ${comment.quote ? `<div class="comment-quote">${escapeHtml(comment.quote)}</div>` : ""}
          ${isEditing
            ? `<textarea class="comment-edit-input" data-edit-comment-input-id="${comment.id}">${escapeHtml(comment.body)}</textarea>`
            : (comment.body ? `<div class="comment-body">${escapeHtml(comment.body)}</div>` : "")}
        </div>
      `;}).join("")}
    </div>
  `;
}

function digestJobs(article) {
  return [...(article?.digestJobs || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function digestMessages(article) {
  return [...(article?.aiMessages || [])].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function aiProviderLabel(provider) {
  return AI_PROVIDERS[normalizeAiProvider(provider)] || AI_PROVIDERS.openai_compatible;
}

function hasRunningDigestJob(article) {
  return digestJobs(article).some((job) => job.status === "queued" || job.status === "running");
}

function isSupersededDigestFailure(article, job) {
  if (job.status !== "failed") return false;
  const failedAt = new Date(job.updatedAt || job.createdAt).getTime();
  return digestJobs(article).some((candidate) => (
    candidate.status === "done"
    && candidate.mode === job.mode
    && new Date(candidate.createdAt).getTime() > failedAt
  ));
}

function renderDigestStatus(article) {
  const jobs = digestJobs(article).filter((job) => (
    job.status !== "done" && !isSupersededDigestFailure(article, job)
  ));
  if (!jobs.length) return "";
  return `
    <div class="digest-status-list">
      ${jobs.slice(0, 3).map((job) => `
        <div class="digest-status ${job.status}">
          <span>${escapeHtml(DIGEST_MODE_LABELS[job.mode] || "Digest")}</span>
          <span class="digest-state">
            ${job.status === "queued" || job.status === "running" ? `<span class="loading-dot" aria-hidden="true"></span>` : ""}
            ${escapeHtml(`${{
              queued: "等待本地 worker",
              running: "消化中",
              failed: "失败"
            }[job.status] || job.status} · ${aiProviderLabel(job.provider)}`)}
          </span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAssistantLoading(job) {
  const label = job.status === "failed"
    ? (job.error || "消化失败")
    : "Answering";
  return `
    <div class="ai-message assistant ${job.status === "failed" ? "failed" : "loading"}">
      <div class="ai-message-content">
        ${job.status === "failed" ? "" : `<span class="loading-dot" aria-hidden="true"></span>`}
        <span>${escapeHtml(label)}</span>
      </div>
    </div>
  `;
}

function renderAiMessages(article) {
  const messages = digestMessages(article);
  const jobsById = new Map((article?.digestJobs || []).map((job) => [job.id, job]));
  const answeredJobIds = new Set(
    messages
      .filter((message) => message.role === "assistant" && message.digestJobId)
      .map((message) => message.digestJobId)
  );
  const renderedJobs = new Set();
  const pendingJobs = (article?.digestJobs || [])
    .filter((job) => (
      job.status !== "done"
      && !answeredJobIds.has(job.id)
      && !isSupersededDigestFailure(article, job)
    ))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!messages.length && !pendingJobs.length) return "";
  return `
    <div class="ai-message-list">
      ${messages.map((message) => `
        <div class="ai-message ${message.role}">
          <div class="ai-message-content">${message.role === "assistant"
            ? renderMarkdown(message.content)
            : escapeHtml(message.content)}</div>
        </div>
        ${(() => {
          const job = jobsById.get(message.digestJobId);
          if (
            message.role !== "user"
            || !job
            || job.status === "done"
            || answeredJobIds.has(job.id)
            || renderedJobs.has(job.id)
            || isSupersededDigestFailure(article, job)
          ) return "";
          renderedJobs.add(job.id);
          return renderAssistantLoading(job);
        })()}
      `).join("")}
      ${pendingJobs
        .filter((job) => !renderedJobs.has(job.id))
        .map((job) => renderAssistantLoading(job))
        .join("")}
    </div>
  `;
}

function renderAiPanel(article) {
  if (!article) return "";
  const running = hasRunningDigestJob(article);
  const latestNotionSync = [...(article.notionSyncs || [])]
    .filter((sync) => sync.status === "done")
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || null;
  const notionState = latestNotionSync
    ? `<div class="notion-sync-state done">已同步到 Notion${latestNotionSync.notionUrl ? ` · <a href="${escapeHtml(latestNotionSync.notionUrl)}" target="_blank" rel="noreferrer">打开</a>` : ""}</div>`
    : "";
  const providerOptions = Object.entries(AI_PROVIDERS).map(([value, label]) => `
    <button
      class="ai-provider-option ${state.aiProvider === value ? "active" : ""}"
      type="button"
      data-ai-provider="${value}"
      aria-pressed="${state.aiProvider === value ? "true" : "false"}"
      ${running ? "disabled" : ""}
    >${escapeHtml(label)}</button>
  `).join("");
  return `
    <section class="panel-section ai-panel">
      <div class="ai-provider-switch" aria-label="AI provider">
        ${providerOptions}
      </div>
      <div class="ai-actions">
        ${DIGEST_ACTIONS.map((action) => `<button class="ai-action-button" type="button" data-digest-mode="${action.mode}" data-tooltip="${escapeHtml(action.tooltip)}" data-instruction="${escapeHtml(action.instruction)}" title="${escapeHtml(action.tooltip)}" aria-label="${escapeHtml(action.tooltip)}" ${running ? "disabled" : ""}>${action.label}</button>`).join("")}
      </div>
      ${renderAiMessages(article)}
      ${notionState}
      <textarea id="ai-input" class="ai-input" placeholder="继续围绕本文讨论" ${running ? "disabled" : ""}></textarea>
    </section>
  `;
}

function renderArticleList() {
  if (state.listMode === "setup") return "";
  const articles = visibleArticles();
  if (!articles.length) {
    return `<div class="list-empty">${state.listMode === "archive" ? "还没有归档内容" : "Inbox 是空的"}</div>`;
  }
  const menu = state.articleMenu ? `
    <div class="article-context-menu" style="left: ${state.articleMenu.x}px; top: ${state.articleMenu.y}px;">
      <button type="button" data-delete-article-id="${state.articleMenu.articleId}">删除</button>
    </div>
  ` : "";
  return articles.map((article) => `
    <div class="article-item ${state.activeArticle?.id === article.id ? "active" : ""}" data-article-id="${article.id}">
      <div class="article-title">${escapeHtml(article.title || article.url)}</div>
      <div class="article-meta">
        ${sourceIcon(article)}
        <span>${formatDate(article.createdAt)}</span>
        ${article.fetchStatus === "failed" ? `<span class="status-icon failed" title="抓取失败" aria-label="抓取失败"></span>` : ""}
      </div>
    </div>
  `).join("") + menu;
}

function renderReader() {
  if (state.listMode === "setup") return renderSettings();

  const article = state.activeArticle;
  if (!article) {
    return `
      <main class="reader">
        <div class="empty">
          ${state.loading
            ? `<span class="loading-dot" aria-hidden="true"></span>`
            : "<h2>Inbox</h2><p>从浏览器插件或 iOS 快捷指令保存的内容会出现在这里。</p>"}
        </div>
      </main>
    `;
  }

  const content = renderArticleContent(article);
  const failed = article.fetchStatus === "failed";
  const needsReview = article.fetchStatus === "needs_review";
  const fetchNotice = failed || needsReview ? `
    <div class="fetch-notice ${failed ? "failed" : "review"}">
      <span>${failed ? "这篇内容没有抓取成功。" : "这篇内容可能需要打开原文确认。"}</span>
      ${article.url ? `<button class="text-action" id="refetch-active-article" type="button" ${state.loading ? "disabled" : ""}>重新抓取</button>` : ""}
    </div>
  ` : "";

  return `
    <main class="reader">
      <div class="article">
        <h1 class="reader-title">${escapeHtml(article.title || article.url)}</h1>
        ${renderReaderMeta(article)}
        ${fetchNotice}
        <article class="content ${article.contentMarkdown ? "structured-content" : "plain-content"}">${content}</article>
      </div>
    </main>
  `;
}

function renderMainTopbar() {
  if (state.listMode === "setup" || !state.activeArticle) return "";
  const article = state.activeArticle;
  const archiveLabel = (article.readingStatus || "inbox") === "archived" ? "Move to Inbox" : "Archive";
  const archiveMode = (article.readingStatus || "inbox") === "archived" ? "restore" : "archive";
  const sidebarLabel = state.sidebarCollapsed ? "显示列表" : "隐藏列表";
  const sourceIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M3.5 12h17"></path>
      <path d="M12 3c2.3 2.6 3.4 5.6 3.4 9s-1.1 6.4-3.4 9"></path>
      <path d="M12 3c-2.3 2.6-3.4 5.6-3.4 9s1.1 6.4 3.4 9"></path>
    </svg>
  `;
  const archiveIcon = archiveMode === "restore" ? `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 8h14"></path>
      <path d="M7 8v10.5A1.5 1.5 0 0 0 8.5 20h7a1.5 1.5 0 0 0 1.5-1.5V8"></path>
      <path d="M9 4h6l1 4H8l1-4Z"></path>
      <path d="M12 17v-6"></path>
      <path d="m9.8 13.2 2.2-2.2 2.2 2.2"></path>
    </svg>
  ` : `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 8h14"></path>
      <path d="M7 8v10.5A1.5 1.5 0 0 0 8.5 20h7a1.5 1.5 0 0 0 1.5-1.5V8"></path>
      <path d="M9 4h6l1 4H8l1-4Z"></path>
      <path d="M12 11v6"></path>
      <path d="m9.8 14.8 2.2 2.2 2.2-2.2"></path>
    </svg>
  `;
  const sidebarIcon = state.sidebarCollapsed ? `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2"></rect>
      <path d="M9 5v14"></path>
      <path d="m12 9 3 3-3 3"></path>
    </svg>
  ` : `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2"></rect>
      <path d="M9 5v14"></path>
      <path d="m15 9-3 3 3 3"></path>
    </svg>
  `;
  const translateIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 5h8"></path>
      <path d="M7 3v2"></path>
      <path d="M4.5 7c1 2.5 3 4.5 5.5 5.5"></path>
      <path d="M11.5 7c-1 2.5-3 4.5-5.5 5.5"></path>
      <path d="M14 17l2-5 2 5"></path>
      <path d="M14.5 15.5h3"></path>
    </svg>
  `;
  return `
    <div class="main-topbar">
      <div class="topbar-leading">
        <button class="icon-action" id="toggle-sidebar" type="button" title="${sidebarLabel}" aria-label="${sidebarLabel}" aria-pressed="${state.sidebarCollapsed ? "true" : "false"}" onclick="window.readlaterToggleSidebar()">${sidebarIcon}</button>
      </div>
      <div class="topbar-title">${escapeHtml(article.title || article.url)}</div>
      <div class="topbar-actions">
        <button class="icon-action ${state.showTranslation ? "active" : ""}" id="toggle-translation" type="button" title="翻译" aria-label="翻译" onclick="window.readlaterToggleTranslation()">${translateIcon}</button>
        ${article.url ? `<a class="icon-action" href="${escapeHtml(article.url)}" target="_blank" rel="noreferrer" title="打开原文" aria-label="打开原文">${sourceIcon}</a>` : ""}
        <button class="icon-action" id="archive-active-article" type="button" title="${escapeHtml(archiveLabel)}" aria-label="${escapeHtml(archiveLabel)}">${archiveIcon}</button>
      </div>
    </div>
  `;
}

function renderSettings() {
  const settings = state.settings;
  const baseUrl = settings?.baseUrl || "http://127.0.0.1:3000";
  const token = settings?.mobileToken || "";
  const endpoint = `${baseUrl}/api/inbox/mobile`;
  const clipEndpoint = `${baseUrl}/api/clip/page`;
  const shortcutBody = `{"url":"快捷指令输入","note":""}`;
  const shortcutName = "存到 Readlater";
  const notion = settings?.notion || {};
  const destinationByKey = new Map((notion.destinations || []).map((item) => [item.key, item]));
  const curlExample = `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/article","note":"可选想法"}'`;

  return `
    <main class="reader">
      <div class="settings-page">
        <section class="settings-section">
          <h2>Setup</h2>
          <p>入口只负责把内容送进 Inbox，阅读、标注和消化都回到网页端。</p>
        </section>
        <section class="settings-section">
          <h3>浏览器插件</h3>
          <p>Chrome 扩展里填写下面两个值。保存当前页面时，插件会发送当前页面渲染后的正文到 Readlater。</p>
          <label>地址</label>
          <div class="copy-box">${escapeHtml(baseUrl)}</div>
          <label>Bearer Token</label>
          <div class="copy-box">${escapeHtml(token)}</div>
          <label>接口</label>
          <div class="copy-box">${escapeHtml(clipEndpoint)}</div>
        </section>
        <section class="settings-section">
          <h3>iOS 快捷指令</h3>
          <p>手机端只做收集：从分享菜单把当前 URL 送进 Inbox，之后回到电脑端阅读和消化。</p>
          <label>快捷指令名称</label>
          <div class="copy-box">${escapeHtml(shortcutName)}</div>
          <label>URL</label>
          <div class="copy-box">${escapeHtml(endpoint)}</div>
          <label>Authorization</label>
          <div class="copy-box">Bearer ${escapeHtml(token)}</div>
          <label>Content-Type</label>
          <div class="copy-box">application/json</div>
          <label>请求体</label>
          <div class="copy-box">${escapeHtml(shortcutBody)}</div>
          <ol>
            <li>新建快捷指令，名称建议填上面的名称。</li>
            <li>顶部第一块设置为“从共享表单接收 App 和 URL”；如果没有输入，选择“继续”。</li>
            <li>添加动作“获取 URL 内容”，URL 填上面的接口。</li>
            <li>方法选择 POST。</li>
            <li>头部添加 Authorization，值填上面完整的 <code>Bearer ...</code>。</li>
            <li>头部再添加 Content-Type，值填 <code>application/json</code>。</li>
            <li>请求体选择 JSON，添加字段 <code>url</code>，字段值选择蓝色变量“快捷指令输入”。</li>
            <li>先不要加 note 字段，保持第一版最稳。</li>
          </ol>
          <label>Token</label>
          <div class="copy-box">${escapeHtml(token)}</div>
          <p>Token 当前没有自动过期时间；除非你重新生成或手动改掉它，否则快捷指令会一直可用。</p>
        </section>
        <section class="settings-section">
          <h3>iOS 快捷指令测试</h3>
          <p>配置完成后，在 Safari 或微信里分享任意链接到这个快捷指令；网页端刷新后应出现在 Inbox 顶部。</p>
          <ol>
            <li>不要在快捷指令编辑页直接空跑，先从 Safari 或微信分享一个真实链接。</li>
            <li>如果快捷指令运行完成，回到 Readlater 刷新 Inbox。</li>
            <li>如果返回 200，说明入口已打通；抓不到正文也会先保存 URL。</li>
            <li>如果返回 401，检查 Authorization 是否是完整的 <code>Bearer token</code>。</li>
            <li>如果没有出现在 Inbox，检查请求体里的 <code>url</code> 是否是蓝色变量“快捷指令输入”。</li>
          </ol>
        </section>
        <section class="settings-section" id="notion-settings">
          <h3>Notion 同步</h3>
          <p>连接后，在文章 AI 对话中用自然语言提出“沉淀”或“同步到 Notion”。模型会根据 digest 规则判断意图，把认知条目追加到最合适的主题页面；标注原文和 Echo comment 由程序从已保存数据中原样写入。</p>
          ${notion.connected ? `<div class="notion-connection">已连接到：${escapeHtml(notion.parentPageTitle || "目标页面")}${notion.parentPageUrl ? ` · <a href="${escapeHtml(notion.parentPageUrl)}" target="_blank" rel="noreferrer">打开 Notion</a>` : ""}</div>` : ""}
          <form id="notion-settings-form" class="notion-settings-form">
            <label for="notion-token">Integration Token</label>
            <input id="notion-token" name="notionToken" type="password" autocomplete="off" placeholder="ntn_..." />
            <label for="notion-parent-page">父页面 URL 或 Page ID</label>
            <input id="notion-parent-page" name="notionParentPage" type="text" value="${escapeHtml(notion.parentPageUrl || notion.parentPageId || "")}" placeholder="https://www.notion.so/..." />
            <label>自动归档主题页</label>
            <p class="notion-help">当你在讨论中明确说“沉淀 / 写入 Notion / 归档”时，AI 只会在这些页面中选择目标主题。留空的主题不会被选中。</p>
            ${NOTION_DESTINATION_TEMPLATES.map(([key, name, description]) => {
              const destination = destinationByKey.get(key);
              return `<label for="notion-destination-${key}">${escapeHtml(name)} <span class="small">${escapeHtml(description)}</span></label>
                <input id="notion-destination-${key}" name="notionDestination_${key}" type="text" value="${escapeHtml(destination?.pageId || "")}" placeholder="主题页面 URL 或 Page ID" />`;
            }).join("")}
            <p class="notion-help">先在 Notion 创建 Internal Integration，并在目标页面的 Add connections 中分享给它。Token 仅保存在服务端，不会回传到浏览器。</p>
            <button class="primary notion-save-button" type="submit" ${state.notionSaving ? "disabled" : ""}>${state.notionSaving ? "正在验证…" : notion.connected ? "更新连接" : "验证并连接"}</button>
            <div class="status notion-settings-status" aria-live="polite">${escapeHtml(state.status)}</div>
          </form>
        </section>
        <section class="settings-section">
          <h3>测试命令</h3>
          <pre>${escapeHtml(curlExample)}</pre>
        </section>
      </div>
    </main>
  `;
}

function renderSidePanel() {
  if (state.listMode === "setup") return "";

  const article = state.activeArticle;
  const commentPlaceholder = article
    ? "写 comment"
    : "";
  const selectionPreview = state.selectedText
    ? `<div class="selection-preview">
        <div class="selection-preview-text">${escapeHtml(state.selectedText)}</div>
        <button class="highlight-only-button" type="button" title="只标注" aria-label="只标注" data-highlight-only>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M6 15.5 14.5 7a2.1 2.1 0 0 1 3 3L9 18.5H5.5v-3Z"></path>
            <path d="M13 8.5 15.5 11"></path>
            <path d="M4 21h10"></path>
          </svg>
        </button>
      </div>`
    : "";
  const commentList = renderCommentList(article);

  return `
    <aside class="side-panel">
      <div
        class="side-panel-resizer"
        role="separator"
        aria-label="调整 Comment 和 AI 面板宽度"
        aria-orientation="vertical"
        aria-valuemin="${MIN_SIDE_PANEL_WIDTH}"
        aria-valuemax="1200"
        aria-valuenow="${Math.round(state.sidePanelWidth)}"
        aria-valuetext="${Math.round(state.sidePanelWidth)} 像素"
        tabindex="0"
        data-side-panel-resizer
      ></div>
      <div class="context-tabs">
        <button class="tab ${state.sideTab === "comment" ? "active" : ""}" type="button" data-side-tab="comment">Comment</button>
        <button class="tab ${state.sideTab === "ai" ? "active" : ""}" type="button" data-side-tab="ai">AI</button>
      </div>
      ${state.sideTab === "ai" ? renderAiPanel(article) : `<section class="panel-section">
        ${article ? `${selectionPreview}<textarea id="comment-input" class="comment-input" placeholder="${commentPlaceholder}"></textarea>${commentList}` : ""}
      </section>`}
    </aside>
  `;
}

function renderArticleView() {
  const shell = document.querySelector(".shell");
  if (!shell) {
    render();
    return;
  }
  shell.classList.toggle(
    "sidebar-collapsed",
    Boolean(state.sidebarCollapsed && state.activeArticle && state.listMode !== "setup")
  );
  document.querySelectorAll(".article-item").forEach((node) => {
    node.classList.toggle("active", node.dataset.articleId === (state.activeArticle?.id || ""));
  });
  const main = shell.querySelector(".main");
  if (!main) {
    render();
    return;
  }
  main.innerHTML = `${renderMainTopbar()}${renderReader()}${renderSidePanel()}`;
  document.querySelector("#archive-active-article")?.addEventListener("click", toggleArchiveActiveArticle);
  document.querySelector("#refetch-active-article")?.addEventListener("click", refetchActiveArticle);
  document.querySelector(".main-topbar")?.addEventListener("wheel", handleTopbarWheel, { passive: false });
  document.querySelector(".reader")?.addEventListener("scroll", handleReaderScroll, { passive: true });
  bindSidePanelHandlers();
}

function isEnglishParagraph(text) {
  if (!text || text.length < 10) return false;
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!letters.length) return false;
  const cjk = letters.replace(/[^一-鿿㐀-䶿　-〿＀-￯]/g, "");
  if (cjk.length > 2) return false;
  const latin = letters.replace(/[^\x00-\x7F]/g, "");
  return latin.length / letters.length > 0.6;
}

function translationCacheKey(text) {
  return text.slice(0, 80);
}

function removeTranslationLines() {
  document.querySelectorAll(".content .translation-line").forEach((el) => el.remove());
}

function setTranslationLoading(loading) {
  const btn = document.querySelector("#toggle-translation");
  if (!btn) return;
  btn.classList.toggle("translating", loading);
  if (loading) {
    btn.innerHTML = `<span class="loading-dot" aria-hidden="true"></span>`;
  } else {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 5h8"></path>
        <path d="M7 3v2"></path>
        <path d="M4.5 7c1 2.5 3 4.5 5.5 5.5"></path>
        <path d="M11.5 7c-1 2.5-3 4.5-5.5 5.5"></path>
        <path d="M14 17l2-5 2 5"></path>
        <path d="M14.5 15.5h3"></path>
      </svg>
    `;
  }
}

function splitLongParagraphs(content) {
  content.querySelectorAll("p").forEach((p) => {
    if (!p.querySelector("br")) return;
    if (p.textContent.trim().length <= 500) return;
    const fragments = p.innerHTML.split(/<br\s*\/?>/gi);
    if (fragments.length <= 1) return;
    const parent = p.parentNode;
    const ref = p.nextSibling;
    fragments.forEach((html) => {
      const trimmed = html.trim();
      if (!trimmed) return;
      const newP = document.createElement("p");
      newP.innerHTML = trimmed;
      parent.insertBefore(newP, ref);
    });
    parent.removeChild(p);
  });
}

async function applyTranslation() {
  const article = state.activeArticle;
  if (!article) return;

  const content = document.querySelector(".content");
  if (!content) return;

  splitLongParagraphs(content);

  const blocks = content.querySelectorAll("p, li, blockquote, h3, h4, h5");
  const toTranslate = [];
  const blockMap = [];

  blocks.forEach((block) => {
    if (block.nextElementSibling?.classList.contains("translation-line")) return;
    const text = block.textContent.trim();
    if (!text || text.length < 10) return;
    if (!isEnglishParagraph(text)) return;
    const key = translationCacheKey(text);
    const cached = translationCache[article.id]?.[key];
    if (cached) {
      const div = document.createElement("div");
      div.className = "translation-line";
      div.textContent = cached;
      block.insertAdjacentElement("afterend", div);
    } else {
      toTranslate.push(text);
      blockMap.push({ block, key });
    }
  });

  if (!toTranslate.length) return;

  setTranslationLoading(true);
  try {
    const response = await fetch(`/api/articles/${article.id}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paragraphs: toTranslate })
    });
    if (!response.ok) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let index = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const result = JSON.parse(line);
          if (!state.showTranslation || state.activeArticle?.id !== article.id) return;
          if (result.translation && blockMap[index]) {
            const { block, key } = blockMap[index];
            translationCache[article.id] ||= {};
            translationCache[article.id][key] = result.translation;
            if (block.isConnected && !block.nextElementSibling?.classList.contains("translation-line")) {
              const div = document.createElement("div");
              div.className = "translation-line";
              div.textContent = result.translation;
              block.insertAdjacentElement("afterend", div);
            }
          }
          index++;
        } catch { index++; }
      }
    }
  } catch {
    // translation request failed silently
  } finally {
    setTranslationLoading(false);
  }
}

function toggleTranslation() {
  if (!state.activeArticle) return;
  state.showTranslation = !state.showTranslation;
  if (state.showTranslation) {
    applyTranslation();
  } else {
    removeTranslationLines();
  }
  const btn = document.querySelector("#toggle-translation");
  if (btn) btn.classList.toggle("active", state.showTranslation);
}

function toggleSidebar() {
  if (state.listMode === "setup" || !state.activeArticle) return;
  state.sidebarCollapsed = !state.sidebarCollapsed;
  render();
}

function bindSidePanelHandlers() {
  bindSidePanelResizer();
  document.querySelectorAll("[data-side-tab]").forEach((node) => {
    node.addEventListener("click", () => {
      state.sideTab = node.dataset.sideTab;
      render();
    });
  });
  const commentInput = document.querySelector("#comment-input");
  commentInput?.addEventListener("focus", () => window.setTimeout(ensureFallbackSelectionMark, 0));
  commentInput?.addEventListener("click", ensureFallbackSelectionMark);
  commentInput?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (state.selectedText) await saveHighlight();
    else await saveArticleNote();
  });
  document.querySelector("[data-highlight-only]")?.addEventListener("click", async () => {
    await saveHighlight("");
  });
  document.querySelectorAll("[data-edit-comment-input-id]").forEach((node) => {
    node.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      await saveEditedComment();
    });
  });
  document.querySelectorAll("[data-comment-menu-id]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCommentMenu(node.dataset.commentMenuId);
    });
  });
  document.querySelectorAll("[data-edit-comment-id]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      editComment(node.dataset.editCommentType, node.dataset.editCommentId);
    });
  });
  document.querySelectorAll("[data-delete-comment-id]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteComment(node.dataset.deleteCommentType, node.dataset.deleteCommentId);
    });
  });
  document.querySelectorAll("[data-digest-mode]").forEach((node) => {
    node.addEventListener("click", () => {
      const mode = node.dataset.digestMode;
      createDigestJob(mode, node.dataset.instruction || node.title || node.getAttribute("aria-label") || node.textContent.trim());
    });
  });
  document.querySelectorAll("[data-ai-provider]").forEach((node) => {
    node.addEventListener("click", () => {
      setAiProvider(node.dataset.aiProvider);
    });
  });
  document.querySelector("#ai-input")?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    await continueDigestDiscussion();
  });
  document.querySelector("#notion-settings-form")?.addEventListener("submit", saveNotionSettings);
}

function render() {
  const previousListMode = app.dataset.currentListMode || state.listMode;
  const previousArticleListScrollTop = articleListScrollTop();
  const previousReaderScrollTop = readerScrollTop();

  if (state.authRequired && !state.authenticated) {
    app.innerHTML = `
      <main class="login-screen">
        <form class="login-box" id="login-form">
          <div>
            <h1>Readlater</h1>
            <p>登录你的私人阅读收件箱。</p>
          </div>
          <input type="password" placeholder="密码" autocomplete="current-password" required autofocus />
          <button class="primary" type="submit" ${state.loading ? "disabled" : ""}>登录</button>
          <div class="status">${escapeHtml(state.status)}</div>
        </form>
      </main>
    `;
    app.dataset.currentListMode = state.listMode;
    document.querySelector("#login-form")?.addEventListener("submit", login);
    return;
  }

  const sidebarCollapsed = state.sidebarCollapsed && state.activeArticle && state.listMode !== "setup";

  app.innerHTML = `
    <div class="shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}">
      <aside class="sidebar">
        <div class="brand">
          <button class="list-tab ${state.listMode !== "archive" && state.listMode !== "setup" ? "active" : ""}" type="button" data-list-mode="inbox">Inbox</button>
          <button class="list-tab ${state.listMode === "archive" ? "active" : ""}" type="button" data-list-mode="archive">Archive</button>
        </div>
        <div class="article-list">${renderArticleList()}</div>
        <div class="sidebar-footer">
          <div class="archive-entry" id="toggle-setup">${state.listMode === "setup" ? "Inbox" : "Setup"}</div>
        </div>
      </aside>
      <div class="main ${state.listMode === "setup" ? "setup-main" : ""}" style="--side-panel-width: ${Math.round(state.sidePanelWidth)}px">
        ${renderMainTopbar()}
        ${renderReader()}
        ${renderSidePanel()}
      </div>
    </div>
  `;
  app.dataset.currentListMode = state.listMode;
  if (previousListMode === state.listMode) {
    restoreArticleListScrollTop(previousArticleListScrollTop);
  }
  if (previousReaderScrollTop > 0 && state.activeArticle) {
    restoreReaderScrollTop(previousReaderScrollTop);
  }

  document.querySelectorAll("[data-article-id]").forEach((node) => {
    node.addEventListener("click", () => loadArticle(node.dataset.articleId));
    node.addEventListener("contextmenu", (event) => openArticleMenu(event, node.dataset.articleId));
  });
  document.querySelector("[data-delete-article-id]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteArticle(event.currentTarget.dataset.deleteArticleId);
  });
  document.querySelectorAll("[data-list-mode]").forEach((node) => {
    node.addEventListener("click", async () => {
      state.listMode = node.dataset.listMode;
      state.activeArticle = null;
      state.articleMenu = null;
      state.sidebarCollapsed = false;
      render();
      loadArticles().catch((error) => {
        state.status = errorMessage(error);
        render();
      });
    });
  });
  document.querySelector("#toggle-setup")?.addEventListener("click", async () => {
    state.listMode = state.listMode === "setup" ? "inbox" : "setup";
    state.activeArticle = null;
    state.articleMenu = null;
    state.sidebarCollapsed = false;
    render();
  });
  document.querySelector("#archive-active-article")?.addEventListener("click", toggleArchiveActiveArticle);
  document.querySelector("#refetch-active-article")?.addEventListener("click", refetchActiveArticle);
  document.querySelector(".main-topbar")?.addEventListener("wheel", handleTopbarWheel, { passive: false });
  document.querySelector(".reader")?.addEventListener("scroll", handleReaderScroll, { passive: true });
  bindSidePanelHandlers();
  const editInput = state.editingComment
    ? document.querySelector(`[data-edit-comment-input-id="${state.editingComment.id}"]`)
    : null;
  if (editInput) {
    editInput.focus();
    editInput.setSelectionRange(editInput.value.length, editInput.value.length);
  }
  if (state.sideTab === "ai") {
    const aiMessageList = document.querySelector(".ai-message-list");
    if (aiMessageList) aiMessageList.scrollTop = aiMessageList.scrollHeight;
  }
}

window.readlaterToggleSidebar = toggleSidebar;
window.readlaterToggleTranslation = toggleTranslation;
document.addEventListener("click", closeArticleMenu);
document.addEventListener("mouseup", handleDocumentMouseUp, true);
document.addEventListener("copy", handleDocumentCopy);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeArticleMenu();
});
window.addEventListener("resize", () => {
  if (!window.matchMedia?.("(max-width: 1080px)").matches) setSidePanelWidth(state.sidePanelWidth);
});
setInterval(pollDigestJobs, 5000);

loadSession()
  .then(() => {
    if (state.authRequired && !state.authenticated) {
      render();
      return null;
    }
    render();
    return Promise.all([loadArticles(), loadSettings()]);
  })
  .catch((error) => {
  state.status = errorMessage(error);
  render();
  });
