(() => {
  const media = [];
  const mediaSeen = new Set();
  const semanticCaptureCache = new WeakMap();
  const sharedNormalizer = globalThis.ReadlaterContentNormalization;
  const CJK = "\\p{Script=Han}";
  const CJK_CLOSING_PUNCTUATION = "，。！？；：、）》】」』〕〉…";
  const CJK_OPENING_PUNCTUATION = "（《【「『〔〈";

  function normalizeProseWhitespace(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0|\u3000/g, " ")
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
      .replace(/[^\S\n]+/g, " ")
      .replace(new RegExp(`([${CJK}]) +(?=[${CJK}])`, "gu"), "$1")
      .replace(new RegExp(`([${CJK}]) +(\\*\\*|\\*)(?=[${CJK}])`, "gu"), "$1$2")
      .replace(new RegExp(`([${CJK}])(\\*\\*|\\*) +(?=[${CJK}])`, "gu"), "$1$2")
      .replace(new RegExp(` +([${CJK_CLOSING_PUNCTUATION}])`, "gu"), "$1")
      .replace(new RegExp(`([${CJK_CLOSING_PUNCTUATION}]) +(?=[${CJK}])`, "gu"), "$1")
      .replace(new RegExp(`([${CJK_OPENING_PUNCTUATION}]) +`, "gu"), "$1");
  }

  function cleanText(value) {
    return normalizeProseWhitespace(value || "")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function cleanMarkdown(value) {
    const source = String(value || "").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
    const parts = [];
    let cursor = 0;

    for (const match of source.matchAll(/```[\s\S]*?```/g)) {
      const before = source.slice(cursor, match.index);
      const cleanedBefore = cleanText(before);
      if (cleanedBefore) parts.push(cleanedBefore);
      parts.push(match[0].replace(/[ \t]+$/gm, "").trim());
      cursor = match.index + match[0].length;
    }

    const rest = cleanText(source.slice(cursor));
    if (rest) parts.push(rest);
    return parts.join("\n\n").trim();
  }

  function textOf(selector) {
    const node = document.querySelector(selector);
    return cleanText(node?.innerText || node?.textContent || "");
  }

  function meta(selector) {
    return document.querySelector(selector)?.getAttribute("content") || "";
  }

  function absoluteUrl(value) {
    if (!value || value.startsWith("data:")) return "";
    try {
      return new URL(value, location.href).href;
    } catch {
      return "";
    }
  }

  function imageUrl(node) {
    const candidates = [
      node.getAttribute("data-src"),
      node.getAttribute("data-original"),
      node.getAttribute("data-backup"),
      node.currentSrc,
      node.getAttribute("src")
    ];
    for (const candidate of candidates) {
      const url = absoluteUrl(candidate || "");
      if (url) return url;
    }
    return "";
  }

  function mediaKey(item) {
    try {
      const url = new URL(item.url);
      if (url.hostname === "pbs.twimg.com" && url.pathname.includes("/media/")) {
        url.searchParams.delete("name");
      }
      return `${item.type || "image"}:${url.href}`;
    } catch {
      return `${item.type || "image"}:${item.url}`;
    }
  }

  function addMedia(item) {
    if (!item.url) return;
    const key = mediaKey(item);
    if (mediaSeen.has(key)) return;
    mediaSeen.add(key);
    media.push(item);
  }

  function captionFor(node) {
    const figure = node.closest("figure");
    return cleanText(figure?.querySelector("figcaption")?.innerText || "");
  }

  function isDecorativeImage(node, url) {
    const loweredUrl = (url || "").toLowerCase();
    const alt = cleanText(node.getAttribute("alt") || "").toLowerCase();
    if (!loweredUrl) return true;
    if (/(trans_?1x1|spacer|blank\.gif|pixel|tracking|transparent)/i.test(loweredUrl)) return true;
    if (/(spacer|blank|pixel|tracking)/i.test(alt)) return true;

    const naturalWidth = Number(node.naturalWidth || node.getAttribute("width") || 0);
    const naturalHeight = Number(node.naturalHeight || node.getAttribute("height") || 0);
    if (naturalWidth && naturalHeight && naturalWidth <= 48 && naturalHeight <= 48) return true;

    const rect = node.getBoundingClientRect?.();
    if (rect?.width && rect?.height && rect.width <= 32 && rect.height <= 32) return true;

    return false;
  }

  function markdownImage(node) {
    const url = imageUrl(node);
    if (!url) return "";
    if (isDecorativeImage(node, url)) return "";
    const alt = cleanText(node.getAttribute("alt") || captionFor(node) || "");
    addMedia({ type: "image", url, alt, caption: captionFor(node) });
    return `![${alt.replaceAll("]", "\\]")}](${url})`;
  }

  function markdownVideo(node) {
    const srcNode = node.querySelector("source");
    const url = absoluteUrl(node.currentSrc || node.getAttribute("src") || srcNode?.getAttribute("src") || "");
    const poster = absoluteUrl(node.getAttribute("poster") || "");
    if (url) addMedia({ type: "video", url, poster, caption: captionFor(node) });
    if (poster) addMedia({ type: "image", url: poster, alt: "video poster", caption: captionFor(node) });
    if (url) return `[视频](${url})`;
    if (poster) return `![video poster](${poster})`;
    return "";
  }

  function isHidden(node) {
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    return style.display === "none" || style.visibility === "hidden" || node.getAttribute("aria-hidden") === "true";
  }

  function isNoiseBlock(node) {
    if (!(node instanceof Element)) return false;
    const attrs = [
      node.id,
      node.className,
      node.getAttribute("aria-label"),
      node.getAttribute("data-testid")
    ].join(" ").toLowerCase();
    if (/(newsletter|subscribe|related|recommended|continue-reading|read-more|more-from|signup)/i.test(attrs)) return true;

    const tag = node.tagName.toLowerCase();
    if (!["aside", "footer", "nav", "section", "div", "form"].includes(tag)) return false;
    const text = cleanText(node.innerText || node.textContent || "").toLowerCase();
    if (!text || text.length > 1400) return false;
    return [
      "product updates, how-tos, community spotlights",
      "delivered monthly to your inbox",
      "developer newsletter",
      "continue reading",
      "related articles",
      "more from",
      "subscribe to",
      "继续阅读",
      "相关文章",
      "查看全部",
      "订阅"
    ].some((marker) => text.includes(marker));
  }

  function skipNode(node) {
    if (!(node instanceof Element)) return false;
    return [
      "SCRIPT",
      "STYLE",
      "NOSCRIPT",
      "SVG",
      "BUTTON",
      "INPUT",
      "TEXTAREA",
      "SELECT",
      "OPTION",
      "NAV",
      "ASIDE",
      "FOOTER"
    ].includes(node.tagName) || isHidden(node) || isNoiseBlock(node);
  }

  function childrenMarkdown(node) {
    return [...node.childNodes].map(nodeToMarkdown).filter(Boolean).join("");
  }

  function trimLine(value) {
    return value.replace(/[ \t]+\n/g, "\n").trim();
  }

  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\s+/g, " ");
    if (!(node instanceof Element) || skipNode(node)) return "";

    const tag = node.tagName.toLowerCase();
    if (tag === "br") return "\n";
    if (tag === "img") return `\n${markdownImage(node)}\n`;
    if (tag === "video") return `\n${markdownVideo(node)}\n`;

    const inner = childrenMarkdown(node);
    const text = trimLine(inner);
    if (!text) return "";

    if (/^h[1-6]$/.test(tag)) {
      return `\n${"#".repeat(Number(tag[1]))} ${text}\n\n`;
    }

    if (tag === "a") {
      const href = absoluteUrl(node.getAttribute("href") || "");
      if (text.includes("![")) return text;
      return href && text ? `[${text.replaceAll("]", "\\]")}](${href})` : text;
    }

    if (tag === "li") return `- ${text}\n`;
    if (tag === "ul" || tag === "ol") return `\n${inner}\n`;
    if (tag === "blockquote") {
      return `\n${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    if (tag === "pre") return `\n\`\`\`\n${node.innerText || node.textContent || ""}\n\`\`\`\n\n`;
    if (tag === "code") return `\`${text}\``;
    if (tag === "strong" || tag === "b") return `**${text}**`;
    if (tag === "em" || tag === "i") return `*${text}*`;

    if (["p", "div", "section", "article", "main", "figure"].includes(tag)) {
      return `\n${text}\n\n`;
    }

    return inner;
  }

  function buildMarkdown(source) {
    if (!sharedNormalizer) return cleanMarkdown(nodeToMarkdown(source));
    return semanticCapture(source).markdown;
  }

  function nodeToText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (!(node instanceof Element) || skipNode(node)) return "";
    if (node.tagName.toLowerCase() === "img" || node.tagName.toLowerCase() === "video") return "";
    const text = [...node.childNodes].map(nodeToText).filter(Boolean).join(" ");
    return /^(p|div|section|article|main|li|h[1-6]|blockquote)$/i.test(node.tagName)
      ? `${text}\n`
      : text;
  }

  function readableText(source) {
    return cleanText(nodeToText(source));
  }

  function collectLooseMedia(source) {
    if (sharedNormalizer) {
      semanticCapture(source);
      return;
    }
    source.querySelectorAll("img").forEach(markdownImage);
    source.querySelectorAll("video").forEach(markdownVideo);
  }

  function inferredHeadingLevel(node, text) {
    const tag = node.tagName?.toLowerCase();
    if (!["div", "p", "section"].includes(tag) || !text || text.length > 100 || text.includes("\n")) return 0;
    if (node.querySelector?.("img,table,ul,ol,pre,blockquote")) return 0;
    const style = getComputedStyle(node);
    const fontSize = Number.parseFloat(style.fontSize || "0");
    const fontWeight = Number.parseInt(style.fontWeight || "400", 10);
    const bold = fontWeight >= 600 || /bold/i.test(style.fontWeight || "");
    const numbered = /^(?:\d+(?:\.\d+)*[.、]?|[一二三四五六七八九十]+[、.])\s*/u.test(text.replace(/[*_`]/g, ""));
    if (!bold && !numbered) return 0;
    if (fontSize >= 22) return 2;
    if (fontSize >= 18 || numbered) return 3;
    return 0;
  }

  function semanticCapture(source) {
    if (semanticCaptureCache.has(source)) return semanticCaptureCache.get(source);
    const result = sharedNormalizer.serializeDom(source, {
      baseUrl: location.href,
      shouldSkipNode: (node) => skipNode(node),
      inferHeadingLevel: inferredHeadingLevel,
      backgroundImage: (node) => getComputedStyle(node).backgroundImage || "",
      onMedia: (item) => addMedia(item)
    });
    semanticCaptureCache.set(source, result);
    return result;
  }

  function xMediaMarkdown(article) {
    const parts = [];
    const videoPlayers = [...article.querySelectorAll('[data-testid="videoPlayer"]')];
    if (!videoPlayers.length) videoPlayers.push(...article.querySelectorAll("video"));
    const videoPosters = new Set();

    videoPlayers.forEach((node) => {
      const video = node.tagName.toLowerCase() === "video" ? node : node.querySelector("video");
      const posterNode = node.querySelector("img");
      const poster = absoluteUrl(
        video?.getAttribute("poster")
        || posterNode?.currentSrc
        || posterNode?.getAttribute("src")
        || ""
      );
      if (poster) videoPosters.add(poster);
    });

    article.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((node) => {
      const url = imageUrl(node);
      if (!url || url.includes("profile_images")) return;
      if (node.closest('[data-testid="videoPlayer"]') || videoPosters.has(url)) return;
      const alt = cleanText(node.getAttribute("alt") || "Image");
      addMedia({ type: "image", url, alt, caption: "" });
      parts.push(`![${alt.replaceAll("]", "\\]")}](${url})`);
    });

    const seenVideos = new Set();

    videoPlayers.forEach((node) => {
      const video = node.tagName.toLowerCase() === "video" ? node : node.querySelector("video");
      const posterNode = node.querySelector("img");
      const rawVideoUrl = video?.currentSrc || video?.getAttribute("src") || "";
      const videoUrl = rawVideoUrl.startsWith("blob:") ? location.href : absoluteUrl(rawVideoUrl);
      const poster = absoluteUrl(
        video?.getAttribute("poster")
        || posterNode?.currentSrc
        || posterNode?.getAttribute("src")
        || ""
      );
      const stableVideoUrl = videoUrl || location.href;
      const key = `${stableVideoUrl}|${poster}`;
      if (seenVideos.has(key)) return;
      seenVideos.add(key);

      addMedia({ type: "video", url: stableVideoUrl, poster, caption: "" });
      parts.push(`[视频](${stableVideoUrl})`);
      if (poster) parts.push(`![video poster](${poster})`);
    });

    return parts.filter(Boolean).join("\n\n");
  }

  function xVideoMarkdown(node, seenVideos = new Set()) {
    const video = node.tagName.toLowerCase() === "video" ? node : node.querySelector("video");
    const posterNode = node.querySelector("img");
    const rawVideoUrl = video?.currentSrc || video?.getAttribute("src") || "";
    const videoUrl = rawVideoUrl.startsWith("blob:") ? location.href : absoluteUrl(rawVideoUrl);
    const poster = absoluteUrl(
      video?.getAttribute("poster")
      || posterNode?.currentSrc
      || posterNode?.getAttribute("src")
      || ""
    );
    const stableVideoUrl = videoUrl || location.href;
    const key = `${stableVideoUrl}|${poster}`;
    if (seenVideos.has(key)) return "";
    seenVideos.add(key);

    addMedia({ type: "video", url: stableVideoUrl, poster, caption: "" });
    return [
      `[视频](${stableVideoUrl})`,
      poster ? `![video poster](${poster})` : ""
    ].filter(Boolean).join("\n\n");
  }

  function xPhotoMarkdown(node) {
    const images = [...node.querySelectorAll("img")];
    return images.map((image) => {
      const url = imageUrl(image);
      if (!url || url.includes("profile_images")) return "";
      if (image.closest('[data-testid="videoPlayer"]')) return "";
      const alt = cleanText(image.getAttribute("alt") || "Image");
      addMedia({ type: "image", url, alt, caption: "" });
      return `![${alt.replaceAll("]", "\\]")}](${url})`;
    }).filter(Boolean).join("\n\n");
  }

  function xArticleMarkdown(article) {
    if (!article) return "";
    const longform = article.querySelector('[data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]');
    if (longform) {
      const title = cleanText(article.querySelector('[data-testid="twitter-article-title"]')?.innerText || "");
      return cleanMarkdown([
        title ? `# ${title}` : "",
        buildMarkdown(longform)
      ].filter(Boolean).join("\n\n"));
    }

    const candidates = [...article.querySelectorAll('[data-testid="tweetText"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"], video')]
      .filter((node, index, nodes) => !nodes.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
    const seenText = new Set();
    const seenVideos = new Set();
    const parts = [];

    candidates.forEach((node) => {
      if (node.matches('[data-testid="tweetText"]')) {
        const text = cleanText(node.innerText || node.textContent || "");
        if (text && !seenText.has(text)) {
          seenText.add(text);
          parts.push(text);
        }
        return;
      }
      if (node.matches('[data-testid="tweetPhoto"]')) {
        const markdown = xPhotoMarkdown(node);
        if (markdown) parts.push(markdown);
        return;
      }
      if (node.matches('[data-testid="videoPlayer"], video')) {
        const markdown = xVideoMarkdown(node, seenVideos);
        if (markdown) parts.push(markdown);
      }
    });

    return cleanMarkdown(parts.join("\n\n"));
  }

  function xContentText(article) {
    if (!article) return cleanText(document.body.innerText || document.body.textContent || "");
    const longform = article.querySelector('[data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]');
    if (longform) {
      const title = cleanText(article.querySelector('[data-testid="twitter-article-title"]')?.innerText || "");
      return cleanText([
        title,
        longform.innerText || longform.textContent || ""
      ].filter(Boolean).join("\n\n"));
    }
    return xPrimaryText(article);
  }

  function xStatusId() {
    return location.pathname.match(/\/status\/(\d+)/)?.[1] || "";
  }

  function visibleRect(node) {
    const rect = node.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      area: Math.max(0, rect.width) * Math.max(0, rect.height)
    };
  }

  function isMeaningfulXArticle(article) {
    return Boolean(
      article
      && !isHidden(article)
      && (
        article.querySelector('[data-testid="tweetText"]')
        || article.querySelector('[data-testid="tweetPhoto"]')
        || article.querySelector('[data-testid="videoPlayer"]')
        || article.querySelector("video")
      )
    );
  }

  function getXArticle() {
    const articles = [...document.querySelectorAll("article")].filter(isMeaningfulXArticle);
    const statusId = xStatusId();
    if (statusId) {
      const matched = articles.find((article) => (
        article.querySelector(`a[href*="/status/${statusId}"]`)
      ));
      if (matched) return matched;
    }
    return articles
      .map((article) => ({ article, rect: visibleRect(article) }))
      .filter((entry) => entry.rect.area > 0 && entry.rect.bottom > 0)
      .sort((a, b) => Math.abs(a.rect.top) - Math.abs(b.rect.top))[0]?.article || articles[0] || null;
  }

  function xPrimaryText(article) {
    const tweetTextNodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
    const text = tweetTextNodes
      .map((node) => cleanText(node.innerText || node.textContent || ""))
      .filter(Boolean)
      .join("\n\n");
    if (text) return text;

    const blocked = new Set([
      "Subscribe",
      "Show translation",
      "显示翻译",
      "Relevant",
      "View quotes"
    ]);
    return cleanText(article.innerText || article.textContent || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !blocked.has(line))
      .filter((line) => !/^[\d.,KMB万]+\s*(Views|次查看)?$/i.test(line))
      .filter((line) => !/^\d+$/.test(line))
      .join("\n");
  }

  function getGeneric() {
    const article = document.querySelector("article");
    const main = document.querySelector("main");
    const source = article || main || document.body;
    collectLooseMedia(source);
    const capture = sharedNormalizer ? semanticCapture(source) : null;
    return {
      url: location.href,
      canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || location.href,
      title: meta('meta[property="og:title"]') || document.title || location.href,
      siteName: meta('meta[property="og:site_name"]') || location.hostname,
      author: meta('meta[name="author"]') || meta('meta[property="article:author"]') || "",
      publishedAt: meta('meta[property="article:published_time"]') || document.querySelector("time")?.getAttribute("datetime") || "",
      contentText: readableText(source),
      contentMarkdown: capture?.markdown || buildMarkdown(source),
      media,
      captureMetrics: capture?.metrics || null,
      source: "chrome_extension",
      contentVersion: 3,
      extractionMethod: "captured_dom_generic"
    };
  }

  function getWeChat() {
    const content = document.querySelector("#js_content") || document.querySelector(".rich_media_content") || document.body;
    collectLooseMedia(content);
    const capture = sharedNormalizer ? semanticCapture(content) : null;
    return {
      url: location.href,
      canonicalUrl: location.href,
      title: textOf("#activity-name") || meta('meta[property="og:title"]') || document.title || location.href,
      siteName: "WeChat",
      author: textOf("#js_name") || textOf("#profileBt") || "",
      publishedAt: textOf("#publish_time") || "",
      contentText: readableText(content),
      contentMarkdown: capture?.markdown || buildMarkdown(content),
      media,
      captureMetrics: capture?.metrics || null,
      source: "chrome_extension",
      contentVersion: 3,
      extractionMethod: "captured_dom_wechat"
    };
  }

  function getX() {
    const article = getXArticle();
    const text = xContentText(article);
    const markdown = article ? xArticleMarkdown(article) : text;
    return {
      url: location.href,
      canonicalUrl: location.href,
      title: text ? `${text.slice(0, 90)} / X` : document.title || location.href,
      siteName: "X",
      author: "",
      publishedAt: "",
      contentText: text,
      contentMarkdown: markdown,
      media,
      captureMetrics: {
        source: { textLength: text.replace(/\s+/g, "").length },
        output: sharedNormalizer?.markdownMetrics(markdown) || {}
      },
      source: "chrome_extension",
      contentVersion: 3,
      extractionMethod: "captured_dom_x"
    };
  }

  if (location.hostname === "mp.weixin.qq.com") return getWeChat();
  if (location.hostname === "x.com" || location.hostname === "twitter.com") return getX();
  return getGeneric();
})();
