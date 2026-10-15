import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  htmlToMarkdown as semanticHtmlToMarkdown,
  normalizeMarkdownPreservingCode as normalizeContentMarkdown,
  normalizeProseWhitespace,
  selectContentHtml
} from "./lib/content-normalization.mjs";
import {
  isXStatusUrl,
  parseFxTwitterArticle,
  shouldPreferIncomingXContent
} from "./lib/x-content.mjs";
import { persistWeChatMedia } from "./lib/media-persistence.mjs";
import {
  evaluateCaptureQuality,
  shouldPreferCapturedContent
} from "./lib/capture-quality.mjs";
import { createDigestInputSnapshot, formatNotionConversation } from "./lib/digest-workflow.mjs";
import {
  appendNotionPage,
  buildNotionEntryMarkdown,
  normalizeNotionPageId,
  validateNotionConnection
} from "./lib/notion-sync.mjs";
import {
  isSupportedPodcastUrl,
  resolvePodcastUrl
} from "./lib/podcast.mjs";
import {
  claimNextTranscriptionJob,
  extractTranscriptionHotwords,
  inferTranscriptionSpeakerCount,
  sanitizeTranscriptSegments,
  transcriptToDocument
} from "./lib/transcription.mjs";
import { isTingwuConfigured } from "./lib/tingwu.mjs";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(rootDir, "public");
const dataDir = process.env.READLATER_DATA_DIR ? resolve(process.env.READLATER_DATA_DIR) : join(rootDir, "data");
const mediaDir = join(dataDir, "media");
const transcriptDir = join(dataDir, "transcripts");
const dbPath = join(dataDir, "readlater.json");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";
const appPassword = process.env.READLATER_PASSWORD || "";
const sessionSecret = process.env.READLATER_SESSION_SECRET || appPassword || createToken();
const translationApiKey = process.env.TRANSLATION_API_KEY || process.env.TENCENT_TRANSLATION_API_KEY || "";
const translationApiUrl = process.env.TRANSLATION_API_URL
  || process.env.TENCENT_TRANSLATION_API_URL
  || "https://api.openai.com/v1/chat/completions";
const translationModel = process.env.TRANSLATION_MODEL || process.env.TENCENT_TRANSLATION_MODEL || "gpt-4o-mini";
const notionTokenFromEnv = process.env.NOTION_TOKEN || "";
const notionParentPageIdFromEnv = process.env.NOTION_PARENT_PAGE_ID || "";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;
const browserUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const transcriptionProvider = String(process.env.TRANSCRIPTION_PROVIDER || "tingwu").toLowerCase();
const transcriptionEnabled = transcriptionProvider === "tingwu";
const transcriptionMaxDurationSeconds = Math.max(60, Number(process.env.TRANSCRIPTION_MAX_DURATION_SECONDS || 10800));
const transcriptionLeaseMs = Math.max(30000, Number(process.env.TRANSCRIPTION_LEASE_MS || 120000));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".img": "application/octet-stream"
};

async function ensureDb() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(transcriptDir, { recursive: true });
  if (!existsSync(dbPath)) {
    await atomicWriteFile(dbPath, JSON.stringify({ articles: [], inboxItems: [], digestJobs: [], transcriptionJobs: [], settings: defaultSettings() }, null, 2));
    return;
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  let changed = false;
  if (!Array.isArray(db.digestJobs)) {
    db.digestJobs = [];
    changed = true;
  }
  if (!Array.isArray(db.transcriptionJobs)) {
    db.transcriptionJobs = [];
    changed = true;
  }
  if (!db.settings) {
    db.settings = defaultSettings();
    changed = true;
  }
  if (!db.settings.mobileToken) {
    db.settings.mobileToken = createToken();
    changed = true;
  }
  if (!db.settings.workerToken) {
    db.settings.workerToken = createToken();
    changed = true;
  }
  if (!db.settings.notion) {
    db.settings.notion = {};
    changed = true;
  }
  if (!Array.isArray(db.settings.notion.destinations)) {
    db.settings.notion.destinations = [];
    changed = true;
  }
  for (const article of db.articles || []) {
    if (!article.contentType) {
      article.contentType = "article";
      changed = true;
    }
    if (!Array.isArray(article.aiMessages)) {
      article.aiMessages = [];
      changed = true;
    }
    if (!Array.isArray(article.notionSyncs)) {
      article.notionSyncs = [];
      changed = true;
    }
  }
  if (changed) {
    await atomicWriteFile(dbPath, JSON.stringify(db, null, 2));
  }
}

let dbCache = null;

async function atomicWriteFile(path, content) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, path);
}

async function readDb() {
  if (dbCache) return JSON.parse(JSON.stringify(dbCache));
  await ensureDb();
  dbCache = JSON.parse(await readFile(dbPath, "utf8"));
  return JSON.parse(JSON.stringify(dbCache));
}

async function writeDb(db) {
  await ensureDb();
  const snapshot = JSON.parse(JSON.stringify(db));
  await atomicWriteFile(dbPath, JSON.stringify(snapshot, null, 2));
  dbCache = snapshot;
}

let mutationTail = Promise.resolve();

async function withMutationLock(task) {
  const previous = mutationTail;
  let release;
  mutationTail = new Promise((resolveLock) => { release = resolveLock; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createToken() {
  return `rl_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function defaultSettings() {
  return {
    mobileToken: createToken(),
    workerToken: createToken(),
    baseUrl: publicBaseUrl || `http://${host}:${port}`,
    notion: {}
  };
}

function signSession(value) {
  return createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function createSessionCookie() {
  const issuedAt = String(Date.now());
  const value = `${issuedAt}.${signSession(issuedAt)}`;
  return `readlater_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionMaxAgeSeconds}`;
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
      })
  );
}

function secureCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hasValidSession(req) {
  if (!appPassword) return true;
  const session = parseCookies(req).readlater_session || "";
  const [issuedAt, signature] = session.split(".");
  if (!issuedAt || !signature) return false;
  const ageSeconds = (Date.now() - Number(issuedAt)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > sessionMaxAgeSeconds) return false;
  return secureCompare(signature, signSession(issuedAt));
}

function sendUnauthorized(res) {
  sendJson(res, 401, { error: "Authentication required" });
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return decodeEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h1|h2|h3|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function cleanExtractedText(value) {
  return trimKnownTailNoise(value
    .split("\n")
    .map((line) => normalizeProseWhitespace(line).trim())
    .filter(Boolean)
    .filter((line) => !line.includes(":host{"))
    .filter((line) => !line.includes("number-flow-react"))
    .filter((line) => !/^Read \d+ replies$/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function cleanExtractedMarkdown(value) {
  return trimKnownTailNoise(normalizeContentMarkdown(decodeEntities(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (full, alt, url) => (
      isDecorativeMediaUrl(url, alt) ? "" : full
    ))));
}

function attrValue(tag, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return decodeEntities(tag.match(pattern)?.[1] || "");
}

function absoluteUrl(value, baseUrl) {
  if (!value || value.startsWith("data:")) return "";
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isDecorativeMediaUrl(url = "", alt = "") {
  const value = `${url} ${alt}`.toLowerCase();
  return /(trans_?1x1|spacer|blank\.gif|pixel|tracking|transparent)/i.test(value);
}

function cleanClaudeBlogMarkdown(markdown = "") {
  const lines = String(markdown || "").split("\n");
  const result = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const next = lines[index + 1]?.trim() || "";

    if (!result.length && /^!\[[^\]]*\]\(https:\/\/cdn\.prod\.website-files\.com\/[^)]+\.svg\)$/i.test(line)) {
      continue;
    }
    if (line === "- Category" || line === "- Product" || line === "- Date") {
      index += next ? 1 : 0;
      continue;
    }
    if (line === "- Reading time") {
      if (next) index += 1;
      if (/^min$/i.test(lines[index + 1]?.trim() || "")) index += 1;
      continue;
    }
    if (line === "- Share") {
      if (/^Copy link\b/i.test(next)) index += 1;
      continue;
    }

    result.push(lines[index]);
  }

  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
  for (const marker of markers) {
    const index = result.toLowerCase().indexOf(marker.toLowerCase());
    if (index > 800) result = result.slice(0, index).trim();
  }
  return result;
}

function removeKnownNoiseBlocks(html = "") {
  return html
    .replace(/<(aside|footer|nav)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(section|div|form)\b[^>]*(newsletter|subscribe|related|recommended|continue-reading|read-more|more-from|signup)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(section|div)\b[^>]*>[\s\S]{0,1600}?(product updates, how-tos, community spotlights|delivered monthly to your inbox|developer newsletter|continue reading|related articles|more from|继续阅读|相关文章|查看全部|订阅)[\s\S]{0,1600}?<\/\1>/gi, " ");
}

function extractMediaFromHtml(html, baseUrl) {
  const media = [];
  const seen = new Set();
  const add = (item) => {
    if (!item.url || seen.has(item.url)) return;
    if (item.type === "image" && isDecorativeMediaUrl(item.url, item.alt || "")) return;
    seen.add(item.url);
    media.push(item);
  };

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const url = absoluteUrl(
      attrValue(tag, "data-src")
      || attrValue(tag, "data-original")
      || attrValue(tag, "data-backup")
      || attrValue(tag, "src"),
      baseUrl
    );
    add({
      type: "image",
      url,
      alt: stripTags(attrValue(tag, "alt")),
      caption: ""
    });
  }

  for (const match of html.matchAll(/<video\b[\s\S]*?<\/video>/gi)) {
    const block = match[0];
    const openTag = block.match(/<video\b[^>]*>/i)?.[0] || "";
    const sourceTag = block.match(/<source\b[^>]*>/i)?.[0] || "";
    const url = absoluteUrl(attrValue(openTag, "src") || attrValue(sourceTag, "src"), baseUrl);
    const poster = absoluteUrl(attrValue(openTag, "poster"), baseUrl);
    if (url) add({ type: "video", url, poster, caption: "" });
    if (poster) add({ type: "image", url: poster, alt: "video poster", caption: "" });
  }

  return media.slice(0, 80);
}

function htmlToMarkdown(html, baseUrl) {
  return cleanExtractedMarkdown(semanticHtmlToMarkdown(html, baseUrl));
}

function pickLargestHtmlBlock(html) {
  const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
  if (articleMatch && stripTags(articleMatch[0]).length > 80) return articleMatch[0];

  const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
  if (mainMatch && stripTags(mainMatch[0]).length > 80) return mainMatch[0];

  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  return bodyMatch?.[0] || html;
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripTags(match[1]).trim();
  }
  return "";
}

function jsonScriptData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(decodeEntities(match[1]));
  } catch {
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
}

function jikeImageUrl(image = {}) {
  return image.picUrl || image.middlePicUrl || image.smallPicUrl || image.thumbnailUrl || "";
}

function jikeMarkdown(content = "", urlsInText = []) {
  let markdown = String(content || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  for (const link of urlsInText || []) {
    const url = link?.originalUrl || link?.url || "";
    if (!url || !markdown.includes(url)) continue;
    const label = (link.title || url).replaceAll("]", "\\]");
    markdown = markdown.replaceAll(url, `[${label}](${url})`);
  }

  return markdown;
}

function extractJike(html, url) {
  const data = jsonScriptData(html);
  const post = data?.props?.pageProps?.post;
  if (!post?.content) return extractGeneric(html, url);

  const markdown = jikeMarkdown(post.content, post.urlsInText);
  const contentText = cleanExtractedText(post.content);
  const media = (post.pictures || [])
    .map((picture) => ({
      type: "image",
      url: jikeImageUrl(picture),
      alt: "",
      caption: ""
    }))
    .filter((item) => item.url);
  const author = post.user?.screenName || "";
  const titleText = cleanExtractedText(post.content).slice(0, 28);

  return {
    url,
    canonicalUrl: url,
    title: `${titleText || firstMatch(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]) || "即刻动态"} - 即刻App`,
    siteName: "即刻",
    author,
    publishedAt: post.createdAt || "",
    contentText,
    contentMarkdown: markdown,
    media: normalizeMedia(media),
    contentHtmlSanitized: "",
    extractionMethod: "jike"
  };
}

function pickLargestTextBlock(html) {
  const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
  if (articleMatch) {
    const articleText = stripTags(articleMatch[0]);
    if (articleText.length > 80) return articleText;
  }

  const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
  if (mainMatch) {
    const mainText = stripTags(mainMatch[0]);
    if (mainText.length > 80) return mainText;
  }

  const candidates = [];
  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  if (bodyMatch) candidates.push(bodyMatch[0]);
  candidates.push(html);

  return candidates
    .map((candidate) => stripTags(candidate))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || "";
}

function extractWeChat(html, url) {
  const title = firstMatch(html, [
    /<h1[^>]*id=["']activity-name["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i
  ]);
  const author = firstMatch(html, [
    /<a[^>]*id=["']js_name["'][^>]*>([\s\S]*?)<\/a>/i,
    /<span[^>]*id=["']profileBt["'][^>]*>([\s\S]*?)<\/span>/i
  ]);
  const selectedContent = selectContentHtml(html, ["#js_content", ".rich_media_content"]);
  const contentHtml = removeKnownNoiseBlocks(selectedContent || pickLargestHtmlBlock(html));
  const contentText = cleanExtractedText(stripTags(contentHtml));
  const verificationBlocked = contentText.includes("环境异常") && contentText.includes("去验证");

  return {
    url,
    title: verificationBlocked ? "WeChat verification required" : title || "Untitled WeChat article",
    siteName: "WeChat",
    author,
    contentText,
    contentMarkdown: htmlToMarkdown(contentHtml, url),
    media: extractMediaFromHtml(contentHtml, url),
    contentHtmlSanitized: "",
    extractionMethod: "wechat",
    fetchStatus: verificationBlocked ? "needs_review" : undefined
  };
}

function extractGeneric(html, url) {
  const title = firstMatch(html, [
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<meta\s+name=["']twitter:title["']\s+content=["']([^"']+)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
  ]);
  const siteName = firstMatch(html, [
    /<meta\s+property=["']og:site_name["']\s+content=["']([^"']+)["']/i
  ]);
  const author = firstMatch(html, [
    /<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i,
    /<meta\s+property=["']article:author["']\s+content=["']([^"']+)["']/i
  ]);
  const publishedAt = firstMatch(html, [
    /<meta\s+property=["']article:published_time["']\s+content=["']([^"']+)["']/i,
    /<time[^>]*datetime=["']([^"']+)["']/i
  ]);
  const contentHtml = removeKnownNoiseBlocks(pickLargestHtmlBlock(html));
  const contentText = cleanExtractedText(stripTags(contentHtml));

  const markdown = htmlToMarkdown(contentHtml, url);
  const hostname = new URL(url).hostname;

  return {
    url,
    title: title || url,
    siteName,
    author,
    publishedAt,
    contentText,
    contentMarkdown: hostname === "claude.com" && url.includes("/blog/")
      ? cleanClaudeBlogMarkdown(markdown)
      : markdown,
    media: extractMediaFromHtml(contentHtml, url),
    contentHtmlSanitized: "",
    extractionMethod: "generic"
  };
}

function extractX(html, url) {
  const result = extractGeneric(html, url);
  const lines = result.contentText.split("\n");
  const cleanedLines = [];
  for (const line of lines) {
    if (/^\d+$/.test(line)) continue;
    if (/^[\d.,KMB]+\s+Views$/i.test(line)) continue;
    cleanedLines.push(line);
  }
  return {
    ...result,
    siteName: result.siteName || "X",
    contentText: cleanExtractedText(cleanedLines.join("\n")),
    contentMarkdown: result.contentMarkdown || "",
    media: result.media || [],
    extractionMethod: "x"
  };
}

async function extractXFromOEmbed(url) {
  const endpoint = `https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(url)}`;
  const response = await fetchWithTimeout(endpoint, {
    headers: {
      "User-Agent": browserUserAgent,
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`X oEmbed failed: ${response.status} ${response.statusText}`);

  const data = await response.json();
  const html = data.html || "";
  const bodyHtml = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || html;
  const contentMarkdown = htmlToMarkdown(bodyHtml, url);
  const contentText = cleanExtractedText(stripTags(bodyHtml));
  if (!contentText) throw new Error("X oEmbed returned empty content");

  const title = `${data.author_name || "X"} on X`;
  return {
    url,
    canonicalUrl: data.url || url,
    title,
    siteName: "X",
    author: data.author_name || "",
    publishedAt: "",
    contentText,
    contentMarkdown,
    media: [],
    contentHtmlSanitized: "",
    extractionMethod: "x_oembed"
  };
}

function xStatusId(url = "") {
  return String(url).match(/\/status(?:es)?\/(\d+)/)?.[1] || "";
}

function xMediaFromFx(media = {}) {
  const entries = Array.isArray(media.all) ? media.all : [];
  return normalizeMedia(entries.map((item) => {
    if (item.type === "video" || item.type === "gif") {
      return {
        type: "video",
        url: item.url || item.formats?.find((format) => format.container === "mp4")?.url || "",
        poster: item.thumbnail_url || "",
        alt: "",
        caption: ""
      };
    }
    return {
      type: "image",
      url: item.url || item.thumbnail_url || "",
      alt: item.altText || "",
      caption: ""
    };
  }));
}

function xMarkdown(text = "", media = []) {
  const mediaLines = media.flatMap((item) => {
    if (item.type === "video") {
      return [
        item.poster ? `![video poster](${item.poster})` : "",
        item.url ? `[视频](${item.url})` : ""
      ].filter(Boolean);
    }
    if (item.type === "image" && item.url) return [`![${(item.alt || "image").replaceAll("]", "\\]")}](${item.url})`];
    return [];
  });
  return [String(text || "").trim(), ...mediaLines].filter(Boolean).join("\n\n");
}

async function extractXFromFxTwitter(url) {
  const statusId = xStatusId(url);
  if (!statusId) throw new Error("X status id not found");
  const endpoint = `https://api.fxtwitter.com/status/${statusId}`;
  const response = await fetchWithTimeout(endpoint, {
    headers: {
      "User-Agent": browserUserAgent,
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`FxTwitter failed: ${response.status} ${response.statusText}`);

  const data = await response.json();
  const tweet = data.tweet || {};
  const authorName = tweet.author?.name || "";
  const screenName = tweet.author?.screen_name || "";
  const tweetText = cleanExtractedText(tweet.text || tweet.raw_text?.text || "");
  const parsedArticle = parseFxTwitterArticle(tweet.article);
  const articleText = cleanExtractedText(parsedArticle?.contentText || "");
  const contentText = articleText || tweetText;
  if (!contentText) throw new Error("FxTwitter returned empty content");

  const articleMarkdown = cleanExtractedMarkdown(parsedArticle?.contentMarkdown || "");
  const tweetMedia = xMediaFromFx(tweet.media || {});
  const media = normalizeMedia([...(parsedArticle?.media || []), ...tweetMedia]);
  const hasUnparsedArticle = Boolean(tweet.article && !parsedArticle);
  return {
    url,
    canonicalUrl: tweet.url || url,
    title: parsedArticle?.title || `${authorName || screenName || "X"}${screenName ? ` (@${screenName})` : ""} on X`,
    siteName: "X",
    author: authorName,
    publishedAt: tweet.created_at || "",
    contentText,
    contentMarkdown: articleMarkdown || xMarkdown(contentText, media),
    contentVersion: 2,
    media,
    contentHtmlSanitized: "",
    fetchStatus: hasUnparsedArticle ? "needs_review" : "ready",
    extractionMethod: parsedArticle ? "x_fxtwitter_article" : "x_fxtwitter"
  };
}

function normalizeMedia(media = []) {
  if (!Array.isArray(media)) return [];
  const normalized = media
    .filter((item) => item && typeof item.url === "string" && item.url)
    .filter((item) => !(item.type === "image" && isDecorativeMediaUrl(item.url, item.alt || "")))
    .map((item) => ({
      type: item.type || "image",
      url: item.url,
      alt: item.alt || "",
      caption: item.caption || "",
      poster: item.poster || "",
      originalUrl: item.originalUrl || "",
      width: Number(item.width || 0) || 0,
      height: Number(item.height || 0) || 0,
      persisted: Boolean(item.persisted),
      source: item.source || ""
    }));
  const videoPosters = new Set(normalized.filter((item) => item.type === "video" && item.poster).map((item) => item.poster));
  const seen = new Set();
  return normalized
    .filter((item) => !(item.type === "image" && videoPosters.has(item.url)))
    .filter((item) => {
      const key = `${item.type}:${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 80);
}

async function extractFromUrl(url) {
  const parsed = new URL(url);
  const isXUrl = parsed.hostname === "x.com" || parsed.hostname === "twitter.com";
  if (isXUrl) {
    try {
      return await extractXFromFxTwitter(url);
    } catch {
      // Fall back to Twitter's public oEmbed endpoint when FxTwitter is unavailable.
    }
    try {
      return await extractXFromOEmbed(url);
    } catch {
      // Fall back to the page HTML when public tweet endpoints are unavailable.
    }
  }
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": browserUserAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  });
  if (!response.ok) {
    if (isXUrl) return extractXFromOEmbed(url);
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  if (parsed.hostname === "mp.weixin.qq.com") return extractWeChat(html, url);
  if (parsed.hostname === "m.okjike.com" || parsed.hostname === "web.okjike.com") return extractJike(html, url);
  if (isXUrl) return extractX(html, url);
  return extractGeneric(html, url);
}

function articleSummary(article) {
  const podcast = article.podcast ? {
    platform: article.podcast.platform,
    showName: article.podcast.showName,
    title: article.podcast.title,
    coverUrl: article.podcast.coverUrl,
    durationSeconds: article.podcast.durationSeconds
  } : null;
  return {
    id: article.id,
    url: article.url,
    title: article.title,
    siteName: article.siteName,
    author: article.author,
    source: article.source,
    contentType: article.contentType || "article",
    podcast,
    transcription: article.transcription || null,
    fetchStatus: article.fetchStatus,
    readingStatus: article.readingStatus,
    excerpt: article.excerpt,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt
  };
}

function transcriptionSettingsForClient() {
  return {
    provider: transcriptionProvider,
    enabled: transcriptionEnabled,
    serverCredentialsDetected: isTingwuConfigured(),
    maxDurationSeconds: transcriptionMaxDurationSeconds
  };
}

function transcriptPath(articleId, version) {
  return join(transcriptDir, articleId, `${version}.json`);
}

async function writeTranscript(articleId, version, payload) {
  const directory = join(transcriptDir, articleId);
  await mkdir(directory, { recursive: true });
  const path = transcriptPath(articleId, version);
  await atomicWriteFile(path, JSON.stringify(payload));
  return `transcripts/${articleId}/${version}.json`;
}

async function readTranscript(article) {
  const relativePath = article?.transcription?.transcriptPath;
  if (!relativePath || !relativePath.startsWith(`transcripts/${article.id}/`)) return null;
  try {
    return JSON.parse(await readFile(join(dataDir, relativePath), "utf8"));
  } catch {
    return null;
  }
}

function queueTranscriptionJob(db, article, { force = false } = {}) {
  db.transcriptionJobs ||= [];
  const active = db.transcriptionJobs.find((job) => (
    job.articleId === article.id && ["queued", "waiting", "running"].includes(job.status)
  ));
  if (active && !force) return active;
  const timestamp = now();
  const transcriptionContext = {
    title: article.title || article.podcast?.title || "",
    showName: article.podcast?.showName || "",
    description: article.podcast?.description || ""
  };
  const job = {
    id: id("transcription"),
    articleId: article.id,
    provider: "tingwu",
    stage: "submit",
    status: "queued",
    audioUrl: article.podcast?.audioUrl || "",
    hotwords: extractTranscriptionHotwords(transcriptionContext),
    speakerCount: inferTranscriptionSpeakerCount(transcriptionContext),
    providerTaskId: "",
    hotwordPhraseId: "",
    attempts: 0,
    errorAttempts: 0,
    nextRunAt: timestamp,
    workerId: "",
    leaseExpiresAt: "",
    error: "",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.transcriptionJobs.push(job);
  article.transcription = {
    ...(article.transcription || {}),
    status: "queued",
    provider: "tingwu",
    providerTaskId: "",
    error: "",
    requestedAt: timestamp,
    updatedAt: timestamp
  };
  article.updatedAt = timestamp;
  return job;
}

function isWorkerAuthorized(req, db) {
  const expectedToken = db.settings?.workerToken || "";
  return Boolean(expectedToken && getBearerToken(req) === expectedToken);
}

function isMobileAuthorized(req, db) {
  const expectedToken = db.settings?.mobileToken || "";
  return Boolean(expectedToken && getBearerToken(req) === expectedToken);
}

function notionConfig(db) {
  const saved = db.settings?.notion || {};
  return {
    token: saved.token || notionTokenFromEnv,
    parentPageId: saved.parentPageId || notionParentPageIdFromEnv,
    parentPageTitle: saved.parentPageTitle || "",
    parentPageUrl: saved.parentPageUrl || ""
  };
}

function notionSettingsForClient(db) {
  const config = notionConfig(db);
  return {
    connected: Boolean(config.token && normalizeNotionPageId(config.parentPageId)),
    parentPageId: normalizeNotionPageId(config.parentPageId),
    parentPageTitle: config.parentPageTitle,
    parentPageUrl: config.parentPageUrl,
    destinations: notionDestinations(db).map(({ pageId, ...destination }) => ({ ...destination, pageId }))
  };
}

function notionDestinations(db) {
  return (db.settings?.notion?.destinations || [])
    .filter((item) => item?.key && item?.name && normalizeNotionPageId(item.pageId))
    .map((item) => ({
      key: String(item.key),
      name: String(item.name),
      description: String(item.description || ""),
      pageId: normalizeNotionPageId(item.pageId)
    }));
}

function requestsNotionSync(actions = []) {
  return Array.isArray(actions) && actions.some((action) => action?.type === "sync_notion");
}

function queueNotionRouteJob(db, article, sourceMessage, sourceJob) {
  const destinations = notionDestinations(db);
  if (!destinations.length || !sourceMessage || !sourceJob) return null;
  const duplicate = (db.digestJobs || []).find((job) => (
    job.mode === "notion_route" && job.sourceDigestMessageId === sourceMessage.id
  ));
  if (duplicate) return duplicate;
  const job = {
    id: id("notion_route"),
    articleId: article.id,
    mode: "notion_route",
    provider: sourceJob.provider,
    status: "queued",
    instruction: "根据已配置 Notion 主题自动路由这次已确认沉淀的内容。",
    inputSnapshot: createDigestInputSnapshot(article),
    sourceDigestMessageId: sourceMessage.id,
    sourceDigestContent: formatNotionConversation(article.aiMessages || []) || sourceMessage.content,
    notionDestinations: destinations,
    result: "",
    error: "",
    createdAt: now(),
    updatedAt: now()
  };
  db.digestJobs ||= [];
  db.digestJobs.push(job);
  return job;
}

async function writeRoutedNotionPages(db, article, job, routing) {
  const config = notionConfig(db);
  if (!config.token) throw new Error("请先在 Setup 中连接 Notion");
  const destinations = new Map(notionDestinations(db).map((item) => [item.key, item]));
  const sourceMessage = (article.aiMessages || []).find((message) => message.id === job.sourceDigestMessageId);
  if (!sourceMessage) throw new Error("找不到需要沉淀的讨论结果");
  const routes = Array.isArray(routing?.routes) ? routing.routes : [];
  const uniqueRoutes = routes.filter((route, index) => {
    if (!destinations.has(route?.destinationKey)) return false;
    const routeKey = `${route.destinationKey}:${String(route.title || "").trim()}`;
    return routes.findIndex((candidate) => (
      `${candidate?.destinationKey}:${String(candidate?.title || "").trim()}` === routeKey
    )) === index;
  });
  if (!uniqueRoutes.length) return [];
  article.notionSyncs ||= [];
  const pages = [];
  for (const route of uniqueRoutes) {
    const destination = destinations.get(route.destinationKey);
    const existing = article.notionSyncs.find((sync) => (
      sync.digestMessageId === sourceMessage.id
      && sync.targetPageId === destination.pageId
      && sync.entryTitle === String(route.title || "").trim()
      && sync.status === "done"
    ));
    if (existing) {
      pages.push(existing);
      continue;
    }
    const selectedHighlights = (route.highlightIndexes || []).map((index) => article.highlights?.[Number(index) - 1]).filter(Boolean);
    const markdown = buildNotionEntryMarkdown(
      { ...article, highlights: selectedHighlights },
      route
    );
    const updated = await appendNotionPage({
      token: config.token,
      pageId: destination.pageId,
      markdown
    });
    const sync = {
      id: id("notion"), articleId: article.id, digestMessageId: sourceMessage.id,
      digestJobId: sourceMessage.digestJobId || "", targetPageId: destination.pageId,
      destinationKey: destination.key, destinationName: destination.name,
      entryTitle: String(route.title || "").trim(), status: "done",
      notionPageId: updated.pageId, notionUrl: updated.pageUrl, error: "", createdAt: now(), updatedAt: now()
    };
    article.notionSyncs.push(sync);
    pages.push(sync);
  }
  if (pages.length && article.readingStatus !== "archived") article.readingStatus = "synced";
  return pages;
}

function articleWithDigest(db, article) {
  return {
    ...article,
    aiMessages: article.aiMessages || [],
    digestJobs: (db.digestJobs || []).filter((job) => job.articleId === article.id)
  };
}

function digestModeLabel(mode) {
  return {
    sop_b_ai_marks: "AI 先读先标注",
    sop_a_echo_marks: "基于标注消化",
    discussion: "继续讨论"
  }[mode] || "Digest";
}

function normalizeDigestProvider() {
  return "openai_compatible";
}

async function createPodcastArticleFromUrl({ url, source = "paste_url", quickNote = "" }) {
  const existingDb = await readDb();
  const existing = existingDb.articles.find((article) => article.url === url || article.canonicalUrl === url);
  if (existing) return { article: existing, inboxItem: null, duplicate: true };

  const podcast = await resolvePodcastUrl(url);
  if (!podcast) throw new Error("暂不支持该播客链接");
  if (podcast.durationSeconds > transcriptionMaxDurationSeconds) {
    throw new Error(`播客时长超过 ${Math.round(transcriptionMaxDurationSeconds / 3600)} 小时限制`);
  }

  const timestamp = now();
  const article = {
    id: id("article"),
    url,
    canonicalUrl: url,
    title: podcast.title,
    siteName: podcast.showName || (podcast.platform === "xiaoyuzhou" ? "小宇宙" : new URL(url).hostname),
    author: podcast.showName || "",
    publishedAt: "",
    excerpt: podcast.description.slice(0, 220),
    contentText: "",
    contentMarkdown: "",
    contentVersion: 0,
    contentType: "podcast_episode",
    podcast,
    media: podcast.coverUrl ? [{ type: "image", url: podcast.coverUrl, alt: podcast.title }] : [],
    contentHtmlSanitized: "",
    source,
    fetchStatus: "ready",
    readingStatus: "inbox",
    extractionMethod: `podcast_${podcast.platform}`,
    notes: quickNote ? [{ id: id("note"), content: quickNote, createdAt: timestamp, updatedAt: timestamp }] : [],
    highlights: [],
    transcription: {
      status: transcriptionEnabled ? "queued" : "not_configured",
      provider: "tingwu",
      providerTaskId: "",
      transcriptVersion: 0,
      transcriptPath: "",
      error: transcriptionEnabled ? "" : "服务器已禁用播客转写",
      requestedAt: timestamp,
      updatedAt: timestamp
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const inboxItem = {
    id: id("inbox"),
    source,
    url,
    title: article.title,
    quickNote,
    status: article.transcription.status,
    articleId: article.id,
    errorMessage: article.transcription.error,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const db = await readDb();
  const duplicate = db.articles.find((entry) => entry.url === url || entry.canonicalUrl === url);
  if (duplicate) return { article: duplicate, inboxItem: null, duplicate: true };
  db.articles.unshift(article);
  db.inboxItems.unshift(inboxItem);
  if (transcriptionEnabled) queueTranscriptionJob(db, article);
  await writeDb(db);
  return { article, inboxItem, duplicate: false };
}

async function createArticleFromUrl({ url, source = "paste_url", quickNote = "" }) {
  if (isSupportedPodcastUrl(url)) return createPodcastArticleFromUrl({ url, source, quickNote });
  const db = await readDb();
  const existing = db.articles.find((article) => article.url === url || article.canonicalUrl === url);
  if (existing) {
    const shouldRefetch = existing.fetchStatus !== "ready" || !existing.contentMarkdown || !existing.media?.length;
    if (shouldRefetch) {
      await refetchArticle(existing.id);
      const nextDb = await readDb();
      const refreshed = nextDb.articles.find((article) => article.id === existing.id);
      return { article: refreshed || existing, inboxItem: null, duplicate: true, updated: true };
    }
    return { article: existing, inboxItem: null, duplicate: true };
  }

  const inboxItem = {
    id: id("inbox"),
    source,
    url,
    title: "",
    quickNote,
    status: "fetching",
    articleId: null,
    errorMessage: "",
    createdAt: now(),
    updatedAt: now()
  };
  db.inboxItems.unshift(inboxItem);
  await writeDb(db);

  try {
    const extracted = await extractFromUrl(url);
    const article = {
      id: id("article"),
      url,
      canonicalUrl: extracted.canonicalUrl || url,
      title: extracted.title,
      siteName: extracted.siteName || new URL(url).hostname,
      author: extracted.author || "",
      publishedAt: extracted.publishedAt || "",
      excerpt: extracted.contentText.slice(0, 220),
      contentText: extracted.contentText,
      contentMarkdown: extracted.contentMarkdown || "",
      contentVersion: extracted.contentVersion || 2,
      contentType: "article",
      media: extracted.media || [],
      contentHtmlSanitized: extracted.contentHtmlSanitized || "",
      source,
      fetchStatus: extracted.fetchStatus || (extracted.contentText ? "ready" : "needs_review"),
      readingStatus: "inbox",
      extractionMethod: extracted.extractionMethod,
      notes: quickNote ? [{ id: id("note"), content: quickNote, createdAt: now(), updatedAt: now() }] : [],
      highlights: [],
      createdAt: now(),
      updatedAt: now()
    };
    const nextDb = await readDb();
    nextDb.articles.unshift(article);
    const item = nextDb.inboxItems.find((entry) => entry.id === inboxItem.id);
    if (item) {
      item.title = article.title;
      item.status = article.fetchStatus;
      item.articleId = article.id;
      item.updatedAt = now();
    }
    await writeDb(nextDb);
    return { article, inboxItem: item, duplicate: false };
  } catch (error) {
    const nextDb = await readDb();
    const item = nextDb.inboxItems.find((entry) => entry.id === inboxItem.id);
    if (item) {
      item.status = "failed";
      item.errorMessage = error.message;
      item.updatedAt = now();
    }
    const article = {
      id: id("article"),
      url,
      canonicalUrl: url,
      title: url,
      siteName: new URL(url).hostname,
      author: "",
      publishedAt: "",
      excerpt: "",
      contentText: "",
      contentMarkdown: "",
      contentVersion: 0,
      contentType: "article",
      media: [],
      contentHtmlSanitized: "",
      source,
      fetchStatus: "failed",
      readingStatus: "inbox",
      extractionMethod: "failed",
      notes: quickNote ? [{ id: id("note"), content: quickNote, createdAt: now(), updatedAt: now() }] : [],
      highlights: [],
      createdAt: now(),
      updatedAt: now()
    };
    nextDb.articles.unshift(article);
    if (item) item.articleId = article.id;
    await writeDb(nextDb);
    return { article, inboxItem: item, duplicate: false };
  }
}

async function prepareCapturedPageMedia(payload) {
  let isWeChat = payload.extractionMethod === "captured_dom_wechat";
  try {
    isWeChat ||= new URL(payload.url).hostname === "mp.weixin.qq.com";
  } catch {
    // URL validation happens in the API handler; leave non-URL payloads untouched here.
  }
  if (!isWeChat) return { ...payload, mediaPersistence: null };
  const result = await persistWeChatMedia({
    markdown: payload.contentMarkdown || "",
    media: payload.media || [],
    referer: payload.url,
    mediaDir,
    fetchImpl: (url, options) => fetchWithTimeout(url, options, 15000)
  });
  return {
    ...payload,
    contentMarkdown: result.markdown,
    media: result.media,
    mediaPersistence: {
      attempted: result.persisted.length + result.failed.length,
      persisted: result.persisted.length,
      failed: result.failed.map((item) => ({ url: item.url, error: item.error }))
    }
  };
}

async function createArticleFromCapturedPage(inputPayload) {
  const payload = await prepareCapturedPageMedia(inputPayload);
  const url = payload.url;
  const db = await readDb();
  const existing = db.articles.find((article) => article.url === url || article.canonicalUrl === url);
  if (existing) {
    const contentText = cleanExtractedText(payload.contentText || "");
    const contentMarkdown = cleanExtractedMarkdown(payload.contentMarkdown || "");
    const media = normalizeMedia(payload.media);
    const captureQuality = evaluateCaptureQuality({
      captureMetrics: payload.captureMetrics,
      contentText,
      contentMarkdown,
      mediaPersistence: payload.mediaPersistence
    });
    const incoming = { ...payload, url, contentText, contentMarkdown, media, captureQuality };
    const shouldReplaceContent = isXStatusUrl(url)
      ? shouldPreferIncomingXContent(existing, incoming)
      : shouldPreferCapturedContent(existing, incoming);
    if ((contentText || contentMarkdown || media.length) && shouldReplaceContent) {
      existing.canonicalUrl = payload.canonicalUrl || existing.canonicalUrl || url;
      existing.title = payload.title || existing.title || url;
      existing.siteName = payload.siteName || existing.siteName || new URL(url).hostname;
      existing.author = payload.author || existing.author || "";
      existing.publishedAt = payload.publishedAt || existing.publishedAt || "";
      existing.excerpt = (contentText || existing.contentText || "").slice(0, 220);
      if (contentText) existing.contentText = contentText;
      if (contentMarkdown) existing.contentMarkdown = contentMarkdown;
      existing.contentVersion = payload.contentVersion || 3;
      existing.media = normalizeMedia([...media, ...(existing.media || [])]);
      existing.contentHtmlSanitized = "";
      existing.mediaPersistence = payload.mediaPersistence || existing.mediaPersistence || null;
      existing.captureMetrics = payload.captureMetrics || null;
      existing.captureQuality = captureQuality;
      existing.source = payload.source || existing.source || "chrome_extension";
      existing.fetchStatus = captureQuality.status;
      existing.extractionMethod = payload.extractionMethod || existing.extractionMethod || "captured_dom";
      existing.updatedAt = now();
      await writeDb(db);
    }
    return {
      article: existing,
      duplicate: true,
      updated: Boolean((contentText || contentMarkdown || media.length) && shouldReplaceContent)
    };
  }

  const contentText = cleanExtractedText(payload.contentText || "");
  const contentMarkdown = cleanExtractedMarkdown(payload.contentMarkdown || "");
  const media = normalizeMedia(payload.media);
  const captureQuality = evaluateCaptureQuality({
    captureMetrics: payload.captureMetrics,
    contentText,
    contentMarkdown,
    mediaPersistence: payload.mediaPersistence
  });
  const fetchStatus = captureQuality.status;
  const article = {
    id: id("article"),
    url,
    canonicalUrl: payload.canonicalUrl || url,
    title: payload.title || url,
    siteName: payload.siteName || new URL(url).hostname,
    author: payload.author || "",
    publishedAt: payload.publishedAt || "",
    excerpt: contentText.slice(0, 220),
    contentText,
    contentMarkdown,
    contentVersion: payload.contentVersion || 3,
    media,
    contentHtmlSanitized: "",
    mediaPersistence: payload.mediaPersistence,
    captureMetrics: payload.captureMetrics || null,
    captureQuality,
    source: payload.source || "chrome_extension",
    fetchStatus,
    readingStatus: "inbox",
    extractionMethod: payload.extractionMethod || "captured_dom",
    notes: [],
    highlights: [],
    createdAt: now(),
    updatedAt: now()
  };

  const inboxItem = {
    id: id("inbox"),
    source: article.source,
    url,
    title: article.title,
    quickNote: "",
    status: fetchStatus,
    articleId: article.id,
    errorMessage: "",
    createdAt: now(),
    updatedAt: now()
  };

  db.articles.unshift(article);
  db.inboxItems.unshift(inboxItem);
  await writeDb(db);
  return { article, duplicate: false };
}

async function refetchArticle(articleId) {
  const db = await readDb();
  const article = db.articles.find((entry) => entry.id === articleId);
  if (!article) return null;
  const inboxItem = db.inboxItems.find((item) => item.articleId === article.id);
  article.fetchStatus = "fetching";
  article.updatedAt = now();
  if (inboxItem) {
    inboxItem.status = "fetching";
    inboxItem.errorMessage = "";
    inboxItem.updatedAt = now();
  }
  try {
    const extracted = await extractFromUrl(article.url);
    const shouldReplaceContent = shouldPreferIncomingXContent(article, {
      ...extracted,
      url: article.url
    });
    article.canonicalUrl = extracted.canonicalUrl || article.url;
    if (shouldReplaceContent) {
      article.title = extracted.title;
      article.siteName = extracted.siteName || new URL(article.url).hostname;
      article.author = extracted.author || "";
      article.publishedAt = extracted.publishedAt || "";
      article.contentText = extracted.contentText;
      article.contentMarkdown = extracted.contentMarkdown || "";
      article.contentVersion = extracted.contentVersion || 2;
      article.media = extracted.media || [];
      article.contentHtmlSanitized = extracted.contentHtmlSanitized || "";
      article.excerpt = extracted.contentText.slice(0, 220);
      article.fetchStatus = extracted.fetchStatus || (extracted.contentText ? "ready" : "needs_review");
      article.extractionMethod = extracted.extractionMethod;
    } else {
      article.fetchStatus = article.fetchStatus === "failed" ? "needs_review" : article.fetchStatus;
    }
    article.updatedAt = now();
    if (inboxItem) inboxItem.errorMessage = "";
  } catch (error) {
    article.fetchStatus = "failed";
    article.extractionMethod = "failed";
    article.errorMessage = error.message;
    article.updatedAt = now();
    if (inboxItem) inboxItem.errorMessage = error.message;
  }
  if (inboxItem) {
    inboxItem.title = article.title;
    inboxItem.status = article.fetchStatus;
    inboxItem.updatedAt = now();
  }
  await writeDb(db);
  return article;
}

async function handleApi(req, res, path) {
  if (req.method === "GET" && path === "/api/auth/session") {
    sendJson(res, 200, {
      authRequired: Boolean(appPassword),
      authenticated: hasValidSession(req)
    });
    return true;
  }

  if (req.method === "POST" && path === "/api/auth/login") {
    if (!appPassword) {
      sendJson(res, 200, { ok: true });
      return true;
    }
    const body = await readJson(req);
    if (typeof body.password !== "string" || !secureCompare(body.password, appPassword)) {
      sendJson(res, 401, { error: "Wrong password" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": createSessionCookie()
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  const isWorkerPath = path === "/api/digest-jobs/next"
    || path.match(/^\/api\/digest-jobs\/[^/]+$/)
    || path.match(/^\/api\/digest-jobs\/[^/]+\/result$/)
    || path === "/api/transcription-jobs/next"
    || path.match(/^\/api\/transcription-jobs\/[^/]+$/)
    || path.match(/^\/api\/transcription-jobs\/[^/]+\/result$/);
  let workerDb = null;
  let workerAuthorized = false;
  if (isWorkerPath) {
    workerDb = await readDb();
    workerAuthorized = isWorkerAuthorized(req, workerDb);
    if (!workerAuthorized) {
      sendJson(res, 401, { error: "Invalid worker token" });
      return true;
    }
  }

  let mobileAuthorized = false;
  if (req.method === "POST" && path === "/api/clip/page") {
    mobileAuthorized = isMobileAuthorized(req, await readDb());
  }

  if (path !== "/api/inbox/mobile" && !workerAuthorized && !mobileAuthorized && !hasValidSession(req)) {
    sendUnauthorized(res);
    return true;
  }

  if (req.method === "GET" && path === "/api/settings") {
    const db = await readDb();
    sendJson(res, 200, {
      settings: {
        baseUrl: publicBaseUrl || db.settings?.baseUrl || `http://${host}:${port}`,
        mobileToken: db.settings?.mobileToken || "",
        workerToken: db.settings?.workerToken || "",
        notion: notionSettingsForClient(db),
        transcription: transcriptionSettingsForClient()
      }
    });
    return true;
  }

  if (req.method === "PUT" && path === "/api/settings/notion") {
    const body = await readJson(req);
    const db = await readDb();
    const existing = notionConfig(db);
    const token = String(body.token || existing.token || "").trim();
    const parentPageId = normalizeNotionPageId(body.parentPageId || existing.parentPageId);
    const destinations = Array.isArray(body.destinations)
      ? body.destinations.map((item) => ({
        key: String(item?.key || "").trim(),
        name: String(item?.name || "").trim(),
        description: String(item?.description || "").trim(),
        pageId: normalizeNotionPageId(item?.pageId || "")
      })).filter((item) => item.key && item.name && item.pageId)
      : (db.settings?.notion?.destinations || []);
    if (!token) {
      sendJson(res, 400, { error: "请输入 Notion Integration Token" });
      return true;
    }
    if (!parentPageId) {
      sendJson(res, 400, { error: "请输入有效的 Notion 父页面链接或 Page ID" });
      return true;
    }
    try {
      const validated = await validateNotionConnection({ token, parentPageId });
      db.settings.notion = {
        token,
        parentPageId: validated.pageId,
        parentPageTitle: validated.pageTitle,
        parentPageUrl: validated.pageUrl,
        destinations,
        updatedAt: now()
      };
      await writeDb(db);
      sendJson(res, 200, {
        ok: true,
        settings: {
          baseUrl: publicBaseUrl || db.settings?.baseUrl || `http://${host}:${port}`,
          mobileToken: db.settings?.mobileToken || "",
          workerToken: db.settings?.workerToken || "",
          notion: notionSettingsForClient(db),
          transcription: transcriptionSettingsForClient()
        }
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/api/inbox") {
    const db = await readDb();
    sendJson(res, 200, {
      items: db.inboxItems.map((item) => ({
        ...item,
        article: db.articles.find((article) => article.id === item.articleId) || null
      }))
    });
    return true;
  }

  if (req.method === "GET" && path === "/api/articles") {
    const db = await readDb();
    sendJson(res, 200, { articles: db.articles.map(articleSummary) });
    return true;
  }

  if (req.method === "GET" && path === "/api/transcription-jobs/next") {
    const db = workerDb || await readDb();
    const workerId = String(req.headers["x-readlater-worker-id"] || "readlater-worker").slice(0, 120);
    const job = claimNextTranscriptionJob(db.transcriptionJobs || [], {
      workerId,
      leaseMs: transcriptionLeaseMs
    });
    if (!job) {
      sendJson(res, 200, { job: null });
      return true;
    }
    await writeDb(db);
    sendJson(res, 200, { job });
    return true;
  }

  if (req.method === "PATCH" && path.match(/^\/api\/transcription-jobs\/[^/]+$/)) {
    const jobId = path.split("/").pop();
    const body = await readJson(req);
    const db = workerDb || await readDb();
    const job = (db.transcriptionJobs || []).find((entry) => entry.id === jobId);
    if (!job) {
      sendJson(res, 404, { error: "Transcription job not found" });
      return true;
    }
    if (["completed", "cancelled"].includes(job.status)) {
      sendJson(res, 409, { error: `Transcription job is already ${job.status}` });
      return true;
    }
    const allowedStatuses = new Set(["queued", "running", "waiting", "failed", "cancelled"]);
    const allowedStages = new Set(["submit", "poll", "cleanup", "finalize"]);
    if (job.cleanupRequested && !(body.status === "cancelled" && body.stage === "cleanup")) {
      sendJson(res, 409, { error: "Transcription cancellation cleanup is pending" });
      return true;
    }
    if (allowedStatuses.has(body.status)) job.status = body.status;
    if (allowedStages.has(body.stage)) job.stage = body.stage;
    if (typeof body.providerTaskId === "string") job.providerTaskId = body.providerTaskId.slice(0, 300);
    if (typeof body.hotwordPhraseId === "string") job.hotwordPhraseId = body.hotwordPhraseId.slice(0, 300);
    if (typeof body.error === "string") job.error = body.error.slice(0, 2000);
    if (Number.isInteger(body.errorAttempts) && body.errorAttempts >= 0) job.errorAttempts = body.errorAttempts;
    if (body.nextRunAt && Number.isFinite(new Date(body.nextRunAt).getTime())) job.nextRunAt = new Date(body.nextRunAt).toISOString();
    if (job.status !== "running") {
      job.workerId = "";
      job.leaseExpiresAt = "";
    }
    job.updatedAt = now();
    const article = db.articles.find((entry) => entry.id === job.articleId);
    if (article && !job.cleanupRequested) {
      article.transcription ||= { provider: job.provider };
      article.transcription.providerTaskId = job.providerTaskId || article.transcription.providerTaskId || "";
      article.transcription.updatedAt = job.updatedAt;
      if (job.status === "failed") {
        article.transcription.status = "failed";
        article.transcription.error = job.error || "转写失败";
      } else if (job.status === "cancelled") {
        article.transcription.status = "cancelled";
      } else {
        article.transcription.status = job.stage === "submit" ? "queued" : "processing";
        if (job.stage !== "submit") article.transcription.startedAt ||= job.updatedAt;
        article.transcription.error = "";
      }
      article.updatedAt = job.updatedAt;
    }
    await writeDb(db);
    sendJson(res, 200, { ok: true, job });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/api\/transcription-jobs\/[^/]+\/result$/)) {
    const jobId = path.split("/")[3];
    const body = await readJson(req);
    const db = workerDb || await readDb();
    const job = (db.transcriptionJobs || []).find((entry) => entry.id === jobId);
    if (!job) {
      sendJson(res, 404, { error: "Transcription job not found" });
      return true;
    }
    const article = db.articles.find((entry) => entry.id === job.articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    if (job.status === "completed") {
      sendJson(res, 200, { ok: true, job, article: articleSummary(article) });
      return true;
    }
    if (job.status === "cancelled" || article.transcription?.status === "cancelled") {
      sendJson(res, 409, { error: "Transcription was cancelled" });
      return true;
    }
    const segments = sanitizeTranscriptSegments(body.segments);
    if (!segments.length) {
      sendJson(res, 400, { error: "Transcript is empty" });
      return true;
    }
    const version = Number(article.transcription?.transcriptVersion || 0) + 1;
    const document = transcriptToDocument(segments);
    const relativePath = await writeTranscript(article.id, version, {
      articleId: article.id,
      version,
      provider: job.provider,
      providerTaskId: job.providerTaskId,
      hotwords: Array.isArray(job.hotwords) ? job.hotwords : [],
      providerMetadata: body.providerMetadata && typeof body.providerMetadata === "object"
        ? body.providerMetadata
        : null,
      correctionMetadata: body.correctionMetadata && typeof body.correctionMetadata === "object"
        ? body.correctionMetadata
        : null,
      segments
    });
    const timestamp = now();
    article.contentText = document.contentText;
    // Keep transcripts as plain text so Markdown punctuation from speech cannot
    // change the rendered characters that highlight anchors are based on.
    article.contentMarkdown = "";
    article.contentVersion = Number(article.contentVersion || 0) + 1;
    article.excerpt = document.contentText.slice(0, 220);
    article.fetchStatus = "ready";
    article.transcription = {
      ...(article.transcription || {}),
      status: "completed",
      provider: job.provider,
      providerTaskId: job.providerTaskId,
      transcriptVersion: version,
      transcriptPath: relativePath,
      segmentCount: segments.length,
      error: "",
      completedAt: timestamp,
      updatedAt: timestamp
    };
    article.updatedAt = timestamp;
    job.status = "completed";
    job.stage = "finalize";
    job.workerId = "";
    job.leaseExpiresAt = "";
    job.updatedAt = timestamp;
    const inboxItem = db.inboxItems.find((entry) => entry.articleId === article.id);
    if (inboxItem) {
      inboxItem.status = "completed";
      inboxItem.errorMessage = "";
      inboxItem.updatedAt = timestamp;
    }
    await writeDb(db);
    sendJson(res, 200, { ok: true, job, article: articleSummary(article) });
    return true;
  }

  if (req.method === "GET" && path === "/api/digest-jobs/next") {
    const db = workerDb || await readDb();
    const job = (db.digestJobs || [])
      .filter((entry) => entry.status === "queued")
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    if (!job) {
      sendJson(res, 200, { job: null });
      return true;
    }
    job.status = "running";
    job.updatedAt = now();
    await writeDb(db);
    sendJson(res, 200, { job });
    return true;
  }

  if (req.method === "PATCH" && path.match(/^\/api\/digest-jobs\/[^/]+$/)) {
    const jobId = path.split("/").pop();
    const body = await readJson(req);
    const db = workerDb || await readDb();
    const job = (db.digestJobs || []).find((entry) => entry.id === jobId);
    if (!job) {
      sendJson(res, 404, { error: "Digest job not found" });
      return true;
    }
    if (["queued", "running", "done", "failed"].includes(body.status)) job.status = body.status;
    if (typeof body.error === "string") job.error = body.error;
    job.updatedAt = now();
    await writeDb(db);
    sendJson(res, 200, { ok: true, job });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/api\/digest-jobs\/[^/]+\/result$/)) {
    const jobId = path.split("/")[3];
    const body = await readJson(req);
    const db = workerDb || await readDb();
    const job = (db.digestJobs || []).find((entry) => entry.id === jobId);
    if (!job) {
      sendJson(res, 404, { error: "Digest job not found" });
      return true;
    }
    const article = db.articles.find((entry) => entry.id === job.articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    const content = body.content || body.result || "";
    job.status = body.status === "failed" ? "failed" : "done";
    job.result = content;
    job.error = body.error || "";
    job.updatedAt = now();
    article.aiMessages ||= [];
    if (job.mode === "notion_route" && job.status === "done") {
      try {
        job.routing = body.routing || JSON.parse(content);
        job.notionPages = await writeRoutedNotionPages(db, article, job, job.routing);
      } catch (error) {
        job.status = "failed";
        job.error = error.message;
      }
    } else if (content) {
      article.aiMessages.push({
        id: id("ai"),
        digestJobId: job.id,
        role: "assistant",
        mode: job.mode,
        provider: normalizeDigestProvider(job.provider),
        content,
        createdAt: now()
      });
      const sourceMessage = article.aiMessages.at(-1);
      if (job.status === "done" && requestsNotionSync(body.actions)) {
        queueNotionRouteJob(db, article, sourceMessage, job);
      }
    }
    article.updatedAt = now();
    await writeDb(db);
    sendJson(res, 200, { ok: true, job, article: articleWithDigest(db, article) });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/api\/articles\/[^/]+\/digest-jobs$/)) {
    const articleId = path.split("/")[3];
    const body = await readJson(req);
    const allowedModes = new Set(["sop_b_ai_marks", "sop_a_echo_marks", "discussion"]);
    const mode = allowedModes.has(body.mode) ? body.mode : "discussion";
    const provider = normalizeDigestProvider(body.provider);
    const db = await readDb();
    const article = db.articles.find((entry) => entry.id === articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    if (article.contentType === "podcast_episode" && article.transcription?.status !== "completed") {
      sendJson(res, 409, { error: "播客转写完成后才能使用 Digest" });
      return true;
    }
    const instruction = body.instruction || body.message || digestModeLabel(mode);
    const job = {
      id: id("digest"),
      articleId,
      mode,
      provider,
      status: "queued",
      instruction,
      inputSnapshot: createDigestInputSnapshot(article),
      result: "",
      error: "",
      createdAt: now(),
      updatedAt: now()
    };
    db.digestJobs ||= [];
    db.digestJobs.push(job);
    article.aiMessages ||= [];
    article.aiMessages.push({
      id: id("ai"),
      digestJobId: job.id,
      role: "user",
      mode,
      provider,
      content: instruction,
      createdAt: now()
    });
    article.updatedAt = now();
    await writeDb(db);
    sendJson(res, 200, { ok: true, job, article: articleWithDigest(db, article) });
    return true;
  }

  if (req.method === "GET" && path.match(/^\/api\/articles\/[^/]+\/digest-jobs$/)) {
    const articleId = path.split("/")[3];
    const db = await readDb();
    sendJson(res, 200, {
      jobs: (db.digestJobs || []).filter((job) => job.articleId === articleId)
    });
    return true;
  }

  if (req.method === "GET" && path.match(/^\/api\/articles\/[^/]+\/transcript$/)) {
    const articleId = path.split("/")[3];
    const db = await readDb();
    const article = db.articles.find((entry) => entry.id === articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    const transcript = await readTranscript(article);
    sendJson(res, 200, {
      articleId,
      status: article.transcription?.status || "not_available",
      version: article.transcription?.transcriptVersion || 0,
      segments: transcript?.segments || []
    });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/api\/articles\/[^/]+\/transcription\/retry$/)) {
    const articleId = path.split("/")[3];
    if (!transcriptionEnabled) {
      sendJson(res, 503, { error: "服务器已禁用播客转写" });
      return true;
    }
    const db = await readDb();
    const article = db.articles.find((entry) => entry.id === articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    if (article.contentType !== "podcast_episode") {
      sendJson(res, 400, { error: "这不是播客内容" });
      return true;
    }
    if (article.transcription?.status === "completed" && article.highlights?.length) {
      sendJson(res, 409, { error: "文稿已有标注，为避免标注错位，不能直接重新转写" });
      return true;
    }
    const active = (db.transcriptionJobs || []).find((job) => (
      job.articleId === articleId
      && !job.cleanupRequested
      && ["queued", "waiting", "running"].includes(job.status)
    ));
    const job = active || queueTranscriptionJob(db, article, { force: true });
    await writeDb(db);
    sendJson(res, 200, { ok: true, job, article: articleSummary(article) });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/api\/articles\/[^/]+\/transcription\/cancel$/)) {
    const articleId = path.split("/")[3];
    const db = await readDb();
    const article = db.articles.find((entry) => entry.id === articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    const timestamp = now();
    for (const job of db.transcriptionJobs || []) {
      if (job.articleId === articleId && ["queued", "waiting", "running"].includes(job.status)) {
        if (job.hotwordPhraseId) {
          job.status = "waiting";
          job.stage = "cleanup";
          job.cleanupRequested = true;
          job.nextRunAt = timestamp;
        } else {
          job.status = "cancelled";
        }
        job.workerId = "";
        job.leaseExpiresAt = "";
        job.updatedAt = timestamp;
      }
    }
    article.transcription = {
      ...(article.transcription || {}),
      status: "cancelled",
      error: "",
      updatedAt: timestamp
    };
    article.updatedAt = timestamp;
    await writeDb(db);
    sendJson(res, 200, { ok: true, article: articleSummary(article) });
    return true;
  }

  if (req.method === "GET" && path.match(/^\/api\/articles\/[^/]+$/)) {
    const articleId = path.split("/").pop();
    const db = await readDb();
    const article = db.articles.find((entry) => entry.id === articleId);
    if (!article) sendJson(res, 404, { error: "Article not found" });
    else sendJson(res, 200, { article: articleWithDigest(db, article) });
    return true;
  }

  if (req.method === "POST" && path === "/api/inbox/url") {
    const body = await readJson(req);
    if (!body.url) {
      sendJson(res, 400, { error: "url is required" });
      return true;
    }
    try {
      const result = await createArticleFromUrl({
        url: body.url,
        source: body.source || "paste_url",
        quickNote: body.note || ""
      });
      sendJson(res, 200, { ok: true, article: articleSummary(result.article), duplicate: result.duplicate });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/api/inbox/mobile") {
    const db = await readDb();
    if (!isMobileAuthorized(req, db)) {
      sendJson(res, 401, { error: "Invalid mobile token" });
      return true;
    }
    const body = await readJson(req);
    if (!body.url) {
      sendJson(res, 400, { error: "url is required" });
      return true;
    }
    try {
      const result = await createArticleFromUrl({
        url: body.url,
        source: "ios_shortcut",
        quickNote: body.note || ""
      });
      sendJson(res, 200, {
        ok: true,
        itemId: result.inboxItem?.id || null,
        article: articleSummary(result.article),
        status: result.article.fetchStatus,
        duplicate: result.duplicate
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/api/clip/page") {
    const body = await readJson(req);
    if (!body.url) {
      sendJson(res, 400, { error: "url is required" });
      return true;
    }
    const result = await createArticleFromCapturedPage(body);
    sendJson(res, 200, {
      ok: true,
      article: articleSummary(result.article),
      duplicate: result.duplicate,
      updated: Boolean(result.updated)
    });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/api\/articles\/[^/]+\/refetch$/)) {
    const articleId = path.split("/")[3];
    const article = await refetchArticle(articleId);
    if (!article) sendJson(res, 404, { error: "Article not found" });
    else sendJson(res, 200, { ok: true, article: articleSummary(article) });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/api\/articles\/[^/]+\/translate$/)) {
    const articleId = path.split("/")[3];
    const body = await readJson(req);
    const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs : [];
    if (!paragraphs.length) {
      sendJson(res, 400, { error: "paragraphs array is required" });
      return true;
    }
    const db = await readDb();
    const article = db.articles.find((entry) => entry.id === articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    article.translations ||= {};
    article.translations.zh ||= {};
    const cache = article.translations.zh;

    const pending = [];
    const cached = [];
    for (const text of paragraphs) {
      const key = text.slice(0, 80);
      if (cache[key]) cached.push({ key, translation: cache[key] });
      else pending.push({ text, key });
    }
    if (pending.length && !translationApiKey) {
      sendJson(res, 503, { error: "Translation API is not configured" });
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache"
    });

    for (const entry of cached) {
      res.write(JSON.stringify(entry) + "\n");
    }

    const batchMaxChars = 6000;
    const batches = [];
    let currentBatch = [];
    let currentLen = 0;
    for (const item of pending) {
      const itemLen = Math.min(item.text.length, 2000);
      if (currentBatch.length && (currentBatch.length >= 20 || currentLen + itemLen > batchMaxChars)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentLen = 0;
      }
      currentBatch.push(item);
      currentLen += itemLen;
    }
    if (currentBatch.length) batches.push(currentBatch);

    const translateChunk = async (text) => {
      const response = await fetchWithTimeout(translationApiUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${translationApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: translationModel,
          messages: [
            { role: "system", content: "Translate the following English text to Chinese. Return only the translation." },
            { role: "user", content: text }
          ],
          stream: false
        })
      }, 30000);
      const data = await response.json();
      return data?.choices?.[0]?.message?.content || "";
    };

    const translateLong = async (item) => {
      const text = item.text;
      const chunkSize = 1500;
      if (text.length <= chunkSize) {
        const translation = await translateChunk(text);
        return translation;
      }
      const sentences = text.split(/(?<=\.)\s+/);
      const chunks = [];
      let current = "";
      for (const sentence of sentences) {
        if (current.length + sentence.length > chunkSize && current) {
          chunks.push(current);
          current = sentence;
        } else {
          current += (current ? " " : "") + sentence;
        }
      }
      if (current) chunks.push(current);
      const parts = [];
      for (const chunk of chunks) {
        parts.push(await translateChunk(chunk));
      }
      return parts.join("");
    };

    for (const batch of batches) {
      const longItems = batch.filter((item) => item.text.length > 2000);
      const shortItems = batch.filter((item) => item.text.length <= 2000);

      for (const item of longItems) {
        try {
          const translation = await translateLong(item);
          if (translation) cache[item.key] = translation;
          res.write(JSON.stringify({ key: item.key, translation }) + "\n");
        } catch {
          res.write(JSON.stringify({ key: item.key, translation: "", error: true }) + "\n");
        }
      }

      if (!shortItems.length) continue;
      const numbered = shortItems.map((item, idx) => `[${idx + 1}] ${item.text.slice(0, 2000)}`).join("\n");
      try {
        const response = await fetchWithTimeout(translationApiUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${translationApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: translationModel,
            messages: [
              { role: "system", content: "Translate each numbered English paragraph to Chinese. Keep the [N] numbering. Return only translations, one per line with its number." },
              { role: "user", content: numbered }
            ],
            stream: false
          })
        }, 30000);
        const data = await response.json();
        const result = data?.choices?.[0]?.message?.content || "";
        const lines = result.split("\n").filter((line) => line.trim());
        const translationMap = new Map();
        for (const line of lines) {
          const match = line.match(/^\[(\d+)\]\s*(.+)$/);
          if (match) translationMap.set(Number(match[1]), match[2].trim());
        }
        shortItems.forEach((item, idx) => {
          const translation = translationMap.get(idx + 1) || "";
          if (translation) cache[item.key] = translation;
          res.write(JSON.stringify({ key: item.key, translation }) + "\n");
        });
      } catch {
        shortItems.forEach((item) => {
          res.write(JSON.stringify({ key: item.key, translation: "", error: true }) + "\n");
        });
      }
    }

    article.updatedAt = now();
    await writeDb(db);
    res.end();
    return true;
  }

  if (req.method === "DELETE" && path.match(/^\/api\/articles\/[^/]+$/)) {
    const articleId = path.split("/").pop();
    const db = await readDb();
    const existing = db.articles.find((article) => article.id === articleId);
    if (!existing) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    db.articles = db.articles.filter((article) => article.id !== articleId);
    db.inboxItems = db.inboxItems.filter((item) => item.articleId !== articleId);
    db.digestJobs = (db.digestJobs || []).filter((job) => job.articleId !== articleId);
    db.transcriptionJobs = (db.transcriptionJobs || []).filter((job) => job.articleId !== articleId);
    await writeDb(db);
    await rm(join(transcriptDir, articleId), { recursive: true, force: true });
    sendJson(res, 200, { ok: true, id: articleId });
    return true;
  }

  if (req.method === "PATCH" && path.match(/^\/api\/articles\/[^/]+\/status$/)) {
    const articleId = path.split("/")[3];
    const body = await readJson(req);
    const allowedStatuses = new Set(["inbox", "archived"]);
    if (!allowedStatuses.has(body.readingStatus)) {
      sendJson(res, 400, { error: "Invalid reading status" });
      return true;
    }
    const db = await readDb();
    const article = db.articles.find((entry) => entry.id === articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    article.readingStatus = body.readingStatus;
    article.updatedAt = now();
    await writeDb(db);
    sendJson(res, 200, { ok: true, article: articleSummary(article) });
    return true;
  }

  if (req.method === "POST" && path.match(/^\/api\/articles\/[^/]+\/highlights$/)) {
    const articleId = path.split("/")[3];
    const body = await readJson(req);
    const db = await readDb();
    const article = db.articles.find((entry) => entry.id === articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    const highlight = {
      id: id("highlight"),
      articleId,
      selectedText: body.selectedText || "",
      prefix: body.prefix || "",
      suffix: body.suffix || "",
      anchorVersion: body.anchorVersion === 2 ? 2 : null,
      textStart: Number.isInteger(body.textStart) && body.textStart >= 0 ? body.textStart : null,
      textEnd: Number.isInteger(body.textEnd) && body.textEnd > body.textStart ? body.textEnd : null,
      color: body.color || "yellow",
      note: body.note || "",
      createdAt: now(),
      updatedAt: now()
    };
    article.highlights ||= [];
    article.highlights.push(highlight);
    article.updatedAt = now();
    await writeDb(db);
    sendJson(res, 200, { ok: true, highlight });
    return true;
  }

  if (req.method === "PATCH" && path.startsWith("/api/highlights/")) {
    const highlightId = path.split("/").pop();
    const body = await readJson(req);
    const db = await readDb();
    let highlight = null;
    for (const article of db.articles) {
      highlight = article.highlights?.find((entry) => entry.id === highlightId);
      if (highlight) {
        if (typeof body.note === "string") highlight.note = body.note;
        highlight.updatedAt = now();
        article.updatedAt = now();
        break;
      }
    }
    if (!highlight) sendJson(res, 404, { error: "Highlight not found" });
    else {
      await writeDb(db);
      sendJson(res, 200, { ok: true, highlight });
    }
    return true;
  }

  if (req.method === "DELETE" && path.startsWith("/api/highlights/")) {
    const highlightId = path.split("/").pop();
    const db = await readDb();
    let deleted = false;
    for (const article of db.articles) {
      const highlights = article.highlights || [];
      const nextHighlights = highlights.filter((entry) => entry.id !== highlightId);
      if (nextHighlights.length !== highlights.length) {
        article.highlights = nextHighlights;
        article.updatedAt = now();
        deleted = true;
        break;
      }
    }
    if (!deleted) sendJson(res, 404, { error: "Highlight not found" });
    else {
      await writeDb(db);
      sendJson(res, 200, { ok: true, id: highlightId });
    }
    return true;
  }

  if (req.method === "POST" && path.match(/^\/api\/articles\/[^/]+\/notes$/)) {
    const articleId = path.split("/")[3];
    const body = await readJson(req);
    const db = await readDb();
    const article = db.articles.find((entry) => entry.id === articleId);
    if (!article) {
      sendJson(res, 404, { error: "Article not found" });
      return true;
    }
    const note = {
      id: id("note"),
      content: body.content || "",
      createdAt: now(),
      updatedAt: now()
    };
    article.notes ||= [];
    article.notes.push(note);
    article.updatedAt = now();
    await writeDb(db);
    sendJson(res, 200, { ok: true, note });
    return true;
  }

  if (req.method === "PATCH" && path.startsWith("/api/notes/")) {
    const noteId = path.split("/").pop();
    const body = await readJson(req);
    const db = await readDb();
    let note = null;
    for (const article of db.articles) {
      note = article.notes?.find((entry) => entry.id === noteId);
      if (note) {
        if (typeof body.content === "string") note.content = body.content;
        note.updatedAt = now();
        article.updatedAt = now();
        break;
      }
    }
    if (!note) sendJson(res, 404, { error: "Note not found" });
    else {
      await writeDb(db);
      sendJson(res, 200, { ok: true, note });
    }
    return true;
  }

  if (req.method === "DELETE" && path.startsWith("/api/notes/")) {
    const noteId = path.split("/").pop();
    const db = await readDb();
    let deleted = false;
    for (const article of db.articles) {
      const notes = article.notes || [];
      const nextNotes = notes.filter((entry) => entry.id !== noteId);
      if (nextNotes.length !== notes.length) {
        article.notes = nextNotes;
        article.updatedAt = now();
        deleted = true;
        break;
      }
    }
    if (!deleted) sendJson(res, 404, { error: "Note not found" });
    else {
      await writeDb(db);
      sendJson(res, 200, { ok: true, id: noteId });
    }
    return true;
  }

  return false;
}

async function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = join(publicDir, safePath);
  if (!fullPath.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const file = await readFile(fullPath);
    sendText(res, 200, file, mimeTypes[extname(fullPath)] || "application/octet-stream");
  } catch {
    const index = await readFile(join(publicDir, "index.html"), "utf8");
    sendText(res, 200, index, mimeTypes[".html"]);
  }
}

async function serveMedia(res, pathname) {
  const safePath = normalize(pathname.slice("/media/".length)).replace(/^(\.\.[/\\])+/, "");
  const fullPath = join(mediaDir, safePath);
  if (!safePath || !fullPath.startsWith(mediaDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const file = await readFile(fullPath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(fullPath)] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable"
    });
    res.end(file);
  } catch {
    sendText(res, 404, "Not found");
  }
}

await ensureDb();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/media/")) {
      await serveMedia(res, url.pathname);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const mutatesState = !["GET", "HEAD"].includes(req.method)
        || url.pathname === "/api/digest-jobs/next"
        || url.pathname === "/api/transcription-jobs/next";
      const handled = mutatesState
        ? await withMutationLock(() => handleApi(req, res, url.pathname))
        : await handleApi(req, res, url.pathname);
      if (!handled) sendJson(res, 404, { error: "Not found" });
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}).listen(port, host, () => {
  console.log(`Readlater running at http://${host}:${port}`);
});
