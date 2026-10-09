(() => {
  if (globalThis.ReadlaterContentNormalization) return;

  const BLOCK_TAGS = new Set([
    "article", "blockquote", "div", "figure", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "main", "ol", "p", "pre", "section", "table", "ul"
  ]);
  const SKIPPED_TAGS = new Set([
    "aside", "button", "canvas", "footer", "input", "nav", "noscript", "option",
    "script", "select", "style", "svg", "textarea"
  ]);
  const CJK = "\\p{Script=Han}";
  const CJK_CLOSING_PUNCTUATION = "，。！？；：、）》】」』〕〉…";
  const CJK_OPENING_PUNCTUATION = "（《【「『〔〈";

  function normalizeProseWhitespace(value = "") {
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

  function normalizeInlineWhitespace(value = "") {
    return normalizeProseWhitespace(String(value || "").replace(/\s+/g, " ")).trim();
  }

  function normalizeMarkdownSegment(value = "") {
    const lines = String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0|\u3000/g, " ")
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
      .split("\n").map((line) => {
      if (!line.trim()) return "";
      const list = line.match(/^(\s*)((?:[-+*]|\d+\.)\s+)(.*)$/u);
      if (list) {
        const indent = list[1].replace(/\t/g, "  ");
        return `${indent}${list[2]}${normalizeProseWhitespace(list[3]).trim()}`.replace(/[ \t]+$/g, "");
      }
      const quote = line.match(/^(\s*>\s*)(.*)$/u);
      if (quote) return `${quote[1]}${normalizeProseWhitespace(quote[2]).trim()}`;
      return normalizeProseWhitespace(line).trim();
    });
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function normalizeMarkdownPreservingCode(value = "") {
    const source = String(value || "").replace(/\r\n?/g, "\n").replace(/\u00a0|\u3000/g, " ");
    const parts = [];
    let cursor = 0;
    for (const match of source.matchAll(/```[\s\S]*?```/g)) {
      const before = normalizeMarkdownSegment(source.slice(cursor, match.index));
      if (before) parts.push(before);
      parts.push(match[0].replace(/[ \t]+$/gm, "").trim());
      cursor = match.index + match[0].length;
    }
    const rest = normalizeMarkdownSegment(source.slice(cursor));
    if (rest) parts.push(rest);
    return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function absoluteUrl(value, baseUrl) {
    const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "");
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return "";
    try {
      const url = new URL(raw, baseUrl);
      return /^https?:$/i.test(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function decorativeMediaUrl(url = "", alt = "") {
    return /(trans_?1x1|spacer|blank\.gif|pixel|tracking|transparent)/i.test(`${url} ${alt}`);
  }

  function srcsetUrls(value = "") {
    return String(value || "")
      .split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0])
      .filter(Boolean)
      .reverse();
  }

  function backgroundUrl(value = "") {
    const match = String(value || "").match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
    return match?.[2] || "";
  }

  function imageCandidates(node, options = {}) {
    const candidates = [];
    const tag = node.tagName?.toLowerCase?.() || "";
    const push = (value) => {
      if (value) candidates.push(value);
    };
    [
      "data-src", "data-original", "data-backup", "data-lazy-src", "data-actualsrc",
      "data-image-url", "data-cover"
    ].forEach((name) => push(node.getAttribute?.(name)));
    const picture = node.parentElement?.tagName?.toLowerCase() === "picture" ? node.parentElement : null;
    picture?.querySelectorAll?.("source").forEach((source) => {
      srcsetUrls(source.getAttribute("data-srcset") || source.getAttribute("srcset")).forEach(push);
      push(source.getAttribute("src"));
    });
    if (["img", "source"].includes(tag)) {
      srcsetUrls(node.getAttribute?.("data-srcset")).forEach(push);
      srcsetUrls(node.getAttribute?.("srcset")).forEach(push);
      push(node.currentSrc);
      push(node.getAttribute?.("src"));
    }

    const inlineBackground = backgroundUrl(node.getAttribute?.("style"));
    const computedBackground = backgroundUrl(options.backgroundImage?.(node) || "");
    push(inlineBackground);
    push(computedBackground);

    const seen = new Set();
    return candidates
      .map((candidate) => absoluteUrl(candidate, options.baseUrl))
      .filter((url) => url && !seen.has(url) && seen.add(url));
  }

  function markdownMetrics(markdown = "") {
    const source = String(markdown || "");
    return {
      textLength: source.replace(/[`#>*_|\[\]()!-]/g, "").replace(/\s+/g, "").length,
      headings: (source.match(/^#{1,6}\s+/gm) || []).length,
      images: (source.match(/!\[[^\]]*\]\((?:https?:\/\/|\/)[^)\s]+\)/g) || []).length,
      tables: (source.match(/^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/gm) || []).length,
      codeBlocks: Math.floor((source.match(/^```/gm) || []).length / 2),
      listItems: (source.match(/^\s*(?:[-+*]|\d+\.)\s+/gm) || []).length
    };
  }

  function serializeDom(root, options = {}) {
    const media = [];
    const mediaSeen = new Set();

    const addMedia = (item) => {
      if (!item?.url || decorativeMediaUrl(item.url, item.alt || "")) return false;
      if (mediaSeen.has(item.url)) return false;
      mediaSeen.add(item.url);
      media.push(item);
      options.onMedia?.(item);
      return true;
    };

    const captionFor = (node) => normalizeInlineWhitespace(
      node.closest?.("figure")?.querySelector?.("figcaption")?.textContent || ""
    );

    const mediaForNode = (node, source = "image") => {
      const alt = normalizeInlineWhitespace(node.getAttribute?.("alt") || captionFor(node));
      const url = imageCandidates(node, options)[0] || "";
      if (!url || decorativeMediaUrl(url, alt)) return null;
      const item = {
        type: "image",
        url,
        originalUrl: url,
        alt,
        caption: captionFor(node),
        width: Number(node.naturalWidth || node.getAttribute?.("width") || 0) || 0,
        height: Number(node.naturalHeight || node.getAttribute?.("height") || 0) || 0,
        source
      };
      addMedia(item);
      return item;
    };

    const childrenMarkdown = (node, context = {}) => [...(node.childNodes || [])]
      .map((child) => serializeNode(child, context))
      .filter(Boolean)
      .join("");

    const tableToMarkdown = (table) => {
      const rows = [...table.querySelectorAll("tr")].map((row) => (
        [...row.querySelectorAll("th, td")].map((cell) => (
          childrenMarkdown(cell, { inline: true })
            .replace(/\s*\n\s*/g, " ")
            .replace(/\|/g, "\\|")
            .trim()
        ))
      )).filter((row) => row.length);
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
      return [
        `| ${normalized[0].join(" | ")} |`,
        `| ${Array(width).fill("---").join(" | ")} |`,
        ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`)
      ].join("\n");
    };

    const serializeList = (list, depth = 0) => {
      const ordered = list.tagName.toLowerCase() === "ol";
      const lines = [];
      [...list.children].filter((child) => child.tagName?.toLowerCase() === "li").forEach((item, index) => {
        const nestedLists = [...item.children].filter((child) => ["ul", "ol"].includes(child.tagName?.toLowerCase()));
        const own = [...item.childNodes]
          .filter((child) => !nestedLists.includes(child))
          .map((child) => serializeNode(child, { inline: true }))
          .join("")
          .replace(/\s*\n\s*/g, " ")
          .trim();
        if (own) lines.push(`${"  ".repeat(depth)}${ordered ? `${index + 1}.` : "-"} ${own}`);
        nestedLists.forEach((nested) => {
          const nestedText = serializeList(nested, depth + 1);
          if (nestedText) lines.push(nestedText);
        });
      });
      return lines.join("\n");
    };

    function serializeNode(node, context = {}) {
      if (node?.nodeType === 3) {
        return normalizeProseWhitespace(String(node.nodeValue || node.textContent || "").replace(/\s+/g, " "));
      }
      if (node?.nodeType !== 1) return "";
      const tag = node.tagName.toLowerCase();
      if (SKIPPED_TAGS.has(tag) || options.shouldSkipNode?.(node)) return "";
      if (tag === "br") return "\n";
      if (tag === "source") return "";

      if (tag === "img") {
        const item = mediaForNode(node, "img");
        return item ? `\n\n![${item.alt.replaceAll("]", "\\]")}](${item.url})\n\n` : "";
      }

      if (tag === "video") {
        const source = node.querySelector?.("source");
        const url = absoluteUrl(node.currentSrc || node.getAttribute("src") || source?.getAttribute("src"), options.baseUrl);
        const poster = absoluteUrl(node.getAttribute("poster"), options.baseUrl);
        if (url) addMedia({ type: "video", url, originalUrl: url, poster, caption: captionFor(node) });
        if (poster) addMedia({ type: "image", url: poster, originalUrl: poster, alt: "video poster", caption: captionFor(node) });
        if (url) return `\n\n[视频](${url})\n\n`;
        if (poster) return `\n\n![video poster](${poster})\n\n`;
        return "";
      }

      const background = tag !== "img" ? mediaForNode(node, "background") : null;
      const backgroundMarkdown = background
        ? `\n\n![${background.alt.replaceAll("]", "\\]")}](${background.url})\n\n`
        : "";

      if (tag === "table") {
        const markdown = tableToMarkdown(node);
        return `${backgroundMarkdown}${markdown ? `\n\n${markdown}\n\n` : ""}`;
      }

      if (tag === "ul" || tag === "ol") {
        const markdown = serializeList(node, context.listDepth || 0);
        return markdown ? `\n\n${markdown}\n\n` : "";
      }
      if (tag === "li") return childrenMarkdown(node, context);

      const inner = childrenMarkdown(node, context);
      const text = inner.replace(/[ \t]+\n/g, "\n").trim();
      const inferredHeading = Number(options.inferHeadingLevel?.(node, text) || 0);
      const nativeHeading = /^h[1-6]$/.test(tag) ? Number(tag[1]) : 0;
      const headingLevel = nativeHeading || (inferredHeading >= 1 && inferredHeading <= 6 ? inferredHeading : 0);
      if (headingLevel && text) return `${backgroundMarkdown}\n\n${"#".repeat(headingLevel)} ${text}\n\n`;

      if (tag === "a") {
        const href = absoluteUrl(node.getAttribute("href"), options.baseUrl);
        if (text.includes("![")) return `${backgroundMarkdown}${text}`;
        return `${backgroundMarkdown}${href && text ? `[${text.replaceAll("]", "\\]")}](${href})` : text}`;
      }
      if (tag === "strong" || tag === "b") return `${backgroundMarkdown}${text ? `**${text}**` : ""}`;
      if (tag === "em" || tag === "i") return `${backgroundMarkdown}${text ? `*${text}*` : ""}`;
      if (tag === "code" && node.parentElement?.tagName?.toLowerCase() !== "pre") {
        const code = node.textContent || "";
        return `${backgroundMarkdown}${code ? `\`${code.replaceAll("`", "\\`")}\`` : ""}`;
      }
      if (tag === "pre") {
        const code = node.textContent || "";
        return `${backgroundMarkdown}${code.trim() ? `\n\n\`\`\`\n${code.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n` : ""}`;
      }
      if (tag === "blockquote") {
        return `${backgroundMarkdown}${text ? `\n\n${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : ""}`;
      }
      if (tag === "figcaption") return `${backgroundMarkdown}${text ? `\n\n*${text}*\n\n` : ""}`;
      if (tag === "p") return `${backgroundMarkdown}${text ? `\n\n${text}\n\n` : ""}`;
      if (["article", "div", "figure", "main", "section"].includes(tag)) {
        if (!text) return backgroundMarkdown;
        const hasBlockChildren = [...node.children].some((child) => BLOCK_TAGS.has(child.tagName.toLowerCase()));
        return `${backgroundMarkdown}${hasBlockChildren ? inner : `\n\n${text}\n\n`}`;
      }
      return `${backgroundMarkdown}${inner}`;
    }

    const markdown = normalizeMarkdownPreservingCode(childrenMarkdown(root));
    const sourceImageUrls = new Set();
    root.querySelectorAll?.("*").forEach((node) => {
      if (options.shouldSkipNode?.(node)) return;
      const url = imageCandidates(node, options)[0] || "";
      const alt = normalizeInlineWhitespace(node.getAttribute?.("alt") || "");
      if (url && !decorativeMediaUrl(url, alt)) sourceImageUrls.add(url);
    });
    let sourceHeadings = 0;
    root.querySelectorAll?.("h1,h2,h3,h4,h5,h6,div,p,section").forEach((node) => {
      if (options.shouldSkipNode?.(node)) return;
      if (/^h[1-6]$/i.test(node.tagName)) {
        sourceHeadings += 1;
        return;
      }
      const text = normalizeInlineWhitespace(node.textContent || "");
      if (options.inferHeadingLevel?.(node, text)) sourceHeadings += 1;
    });
    const metrics = {
      source: {
        textLength: normalizeProseWhitespace(root.textContent || "").replace(/\s+/g, "").length,
        headings: sourceHeadings,
        images: sourceImageUrls.size,
        tables: root.querySelectorAll?.("table")?.length || 0,
        codeBlocks: root.querySelectorAll?.("pre")?.length || 0,
        listItems: root.querySelectorAll?.("li")?.length || 0
      },
      output: markdownMetrics(markdown)
    };
    return { markdown, media, metrics };
  }

  globalThis.ReadlaterContentNormalization = {
    absoluteUrl,
    decorativeMediaUrl,
    imageCandidates,
    markdownMetrics,
    normalizeMarkdownPreservingCode,
    normalizeProseWhitespace,
    serializeDom
  };
})();
