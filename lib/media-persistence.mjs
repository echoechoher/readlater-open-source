import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname } from "node:path";

const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const WECHAT_MEDIA_HOSTS = new Set([
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn",
  "wx.qlogo.cn"
]);
const CONTENT_TYPE_EXTENSIONS = new Map([
  ["image/avif", ".avif"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

export function isPersistableWeChatMediaUrl(value = "") {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && WECHAT_MEDIA_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function extensionFor(url, contentType = "") {
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  if (CONTENT_TYPE_EXTENSIONS.has(normalizedType)) return CONTENT_TYPE_EXTENSIONS.get(normalizedType);
  try {
    const extension = extname(new URL(url).pathname).toLowerCase();
    if ([...CONTENT_TYPE_EXTENSIONS.values()].includes(extension)) return extension;
    if (extension === ".jpeg") return ".jpg";
  } catch {
    // Fall through to a safe generic image extension.
  }
  return ".img";
}

async function readBodyWithLimit(response, maxBytes = MAX_MEDIA_BYTES) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error(`Media exceeds ${maxBytes} bytes`);
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`Media exceeds ${maxBytes} bytes`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Media exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function replaceAllLiteral(value, before, after) {
  return before && after ? String(value || "").split(before).join(after) : String(value || "");
}

export async function persistWeChatMedia({
  markdown = "",
  media = [],
  referer = "",
  mediaDir,
  publicPrefix = "/media",
  fetchImpl = fetch,
  maxItems = 80,
  maxBytes = MAX_MEDIA_BYTES
}) {
  const candidates = [...new Set((media || [])
    .filter((item) => item?.type === "image" && isPersistableWeChatMediaUrl(item.url))
    .map((item) => item.url))]
    .slice(0, maxItems);
  if (!candidates.length) return { markdown, media, persisted: [], failed: [] };

  await mkdir(mediaDir, { recursive: true });
  const outcomes = await mapWithConcurrency(candidates, 4, async (url) => {
    try {
      const response = await fetchImpl(url, {
        headers: {
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Referer": referer || "https://mp.weixin.qq.com/",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"
        },
        redirect: "follow"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().startsWith("image/")) throw new Error(`Unexpected content type: ${contentType || "unknown"}`);
      const bytes = await readBodyWithLimit(response, maxBytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const filename = `${hash}${extensionFor(url, contentType)}`;
      await writeFile(new URL(filename, `file://${mediaDir.replace(/\/$/, "")}/`), bytes);
      return { url, localUrl: `${publicPrefix.replace(/\/$/, "")}/${filename}` };
    } catch (error) {
      return { url, error: error.message };
    }
  });

  const persisted = outcomes.filter((item) => item.localUrl);
  const failed = outcomes.filter((item) => item.error);
  const replacements = new Map(persisted.map((item) => [item.url, item.localUrl]));
  let nextMarkdown = markdown;
  replacements.forEach((localUrl, originalUrl) => {
    nextMarkdown = replaceAllLiteral(nextMarkdown, originalUrl, localUrl);
  });
  const nextMedia = (media || []).map((item) => {
    const localUrl = replacements.get(item.url);
    if (!localUrl) return item;
    return { ...item, originalUrl: item.originalUrl || item.url, url: localUrl, persisted: true };
  });
  return { markdown: nextMarkdown, media: nextMedia, persisted, failed };
}
