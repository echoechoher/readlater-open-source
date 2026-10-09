function escapeMarkdownText(value = "") {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function safeHttpUrl(value = "") {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function entityMapFrom(value) {
  if (Array.isArray(value)) {
    return new Map(value.map((entry) => [String(entry?.key), entry?.value || {}]));
  }
  if (value && typeof value === "object") {
    return new Map(Object.entries(value));
  }
  return new Map();
}

function validRange(range, textLength) {
  const start = Number(range?.offset);
  const length = Number(range?.length);
  return Number.isInteger(start)
    && Number.isInteger(length)
    && start >= 0
    && length > 0
    && start < textLength;
}

function renderInlineText(block, entityMap) {
  const text = String(block?.text || "");
  if (!text) return "";

  const entityRanges = (Array.isArray(block.entityRanges) ? block.entityRanges : [])
    .filter((range) => validRange(range, text.length))
    .map((range) => ({
      ...range,
      start: Number(range.offset),
      end: Math.min(text.length, Number(range.offset) + Number(range.length))
    }));
  const styleRanges = (Array.isArray(block.inlineStyleRanges) ? block.inlineStyleRanges : [])
    .filter((range) => validRange(range, text.length))
    .map((range) => ({
      ...range,
      start: Number(range.offset),
      end: Math.min(text.length, Number(range.offset) + Number(range.length))
    }));

  const boundaries = new Set([0, text.length]);
  [...entityRanges, ...styleRanges].forEach((range) => {
    boundaries.add(range.start);
    boundaries.add(range.end);
  });
  const points = [...boundaries].sort((a, b) => a - b);
  const parts = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start === end) continue;

    const raw = text.slice(start, end);
    const styles = new Set(
      styleRanges
        .filter((range) => range.start <= start && range.end >= end)
        .map((range) => String(range.style || "").toLowerCase())
    );
    const entityRange = entityRanges.find((range) => range.start <= start && range.end >= end);
    const entity = entityRange ? entityMap.get(String(entityRange.key)) : null;

    let rendered = escapeMarkdownText(raw);
    if (styles.has("code")) rendered = `\`${rendered.replaceAll("`", "\\`")}\``;
    if (styles.has("bold") && styles.has("italic")) rendered = `***${rendered}***`;
    else if (styles.has("bold")) rendered = `**${rendered}**`;
    else if (styles.has("italic")) rendered = `*${rendered}*`;

    if (String(entity?.type || "").toUpperCase() === "LINK") {
      const url = safeHttpUrl(entity?.data?.url || entity?.data?.href || "");
      if (url) rendered = `[${rendered}](${url})`;
    }
    parts.push(rendered);
  }

  return parts.join("");
}

function atomicBlockMarkdown(block, entityMap) {
  const entityRange = Array.isArray(block?.entityRanges) ? block.entityRanges[0] : null;
  const entity = entityRange ? entityMap.get(String(entityRange.key)) : null;
  const type = String(entity?.type || "").toUpperCase();
  if (type === "DIVIDER") return "---";
  return "";
}

function blocksToMarkdown(blocks, entityMap) {
  const parts = [];
  let orderedIndex = 0;

  for (const block of blocks) {
    const type = String(block?.type || "unstyled").toLowerCase();
    const text = renderInlineText(block, entityMap).trim();

    if (type !== "ordered-list-item") orderedIndex = 0;
    if (type === "atomic") {
      const atomic = atomicBlockMarkdown(block, entityMap);
      if (atomic) parts.push(atomic);
      continue;
    }
    if (!text) continue;

    if (type === "header-one") parts.push(`# ${text}`);
    else if (type === "header-two") parts.push(`## ${text}`);
    else if (type === "header-three") parts.push(`### ${text}`);
    else if (type === "blockquote") parts.push(text.split("\n").map((line) => `> ${line}`).join("\n"));
    else if (type === "unordered-list-item") {
      const depth = Math.max(0, Number(block.depth) || 0);
      parts.push(`${"  ".repeat(depth)}- ${text}`);
    } else if (type === "ordered-list-item") {
      orderedIndex += 1;
      const depth = Math.max(0, Number(block.depth) || 0);
      parts.push(`${"  ".repeat(depth)}${orderedIndex}. ${text}`);
    } else if (type === "code-block") {
      parts.push(`\`\`\`\n${String(block.text || "").trim()}\n\`\`\``);
    } else {
      parts.push(text);
    }
  }

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function blocksToText(blocks) {
  return blocks
    .map((block) => String(block?.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function mediaFromArticleEntity(entity, fallbackAlt = "") {
  const value = entity?.value || entity || {};
  const info = value.media_info || value.mediaInfo || value.info || {};
  const imageUrl = safeHttpUrl(
    info.original_img_url
    || info.originalImageUrl
    || value.original_img_url
    || value.url
    || value.media_url_https
    || ""
  );
  if (imageUrl) {
    return {
      type: "image",
      url: imageUrl,
      alt: value.alt_text || value.altText || fallbackAlt,
      caption: "",
      poster: ""
    };
  }

  const variants = info.variants || value.variants || [];
  const video = [...variants]
    .filter((variant) => safeHttpUrl(variant?.url || ""))
    .sort((a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0))[0];
  const videoUrl = safeHttpUrl(video?.url || "");
  if (!videoUrl) return null;
  return {
    type: "video",
    url: videoUrl,
    alt: "",
    caption: "",
    poster: safeHttpUrl(info.original_img_url || value.thumbnail_url || "")
  };
}

function articleMedia(article, title) {
  const candidates = [
    article?.cover_media,
    ...(Array.isArray(article?.media_entities)
      ? article.media_entities
      : Object.values(article?.media_entities || {}))
  ];
  const seen = new Set();
  return candidates
    .map((entry, index) => mediaFromArticleEntity(entry, index === 0 ? title : ""))
    .filter(Boolean)
    .filter((item) => {
      const key = `${item.type}:${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function parseFxTwitterArticle(article) {
  if (!article || typeof article !== "object") return null;
  const title = String(article.title || "").trim();
  const blocks = Array.isArray(article.content?.blocks) ? article.content.blocks : [];
  const entityMap = entityMapFrom(article.content?.entityMap);
  const bodyText = blocksToText(blocks);
  const bodyMarkdown = blocksToMarkdown(blocks, entityMap);
  const media = articleMedia(article, title);

  if (!bodyText && !bodyMarkdown) return null;

  const cover = media.find((item) => item.type === "image");
  const contentMarkdown = [
    cover ? `![${escapeMarkdownText(cover.alt || title || "cover")}](${cover.url})` : "",
    bodyMarkdown
  ].filter(Boolean).join("\n\n");

  return {
    title,
    contentText: bodyText,
    contentMarkdown,
    media
  };
}

export function isXStatusUrl(value = "") {
  try {
    const url = new URL(value);
    return (url.hostname === "x.com" || url.hostname === "twitter.com")
      && /\/status(?:es)?\/\d+/.test(url.pathname);
  } catch {
    return false;
  }
}

function contentLength(value) {
  return Math.max(
    String(value?.contentText || "").trim().length,
    String(value?.contentMarkdown || "").trim().length
  );
}

export function shouldPreferIncomingXContent(existing, incoming) {
  const url = incoming?.url || incoming?.canonicalUrl || existing?.url || existing?.canonicalUrl || "";
  if (!isXStatusUrl(url)) return true;

  const currentLength = contentLength(existing);
  const incomingLength = contentLength(incoming);
  if (!currentLength) return incomingLength > 0;
  if (!incomingLength) return false;
  return incomingLength >= currentLength;
}
