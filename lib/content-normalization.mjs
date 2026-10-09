import { parseHTML } from "linkedom";
import "../extension/content-normalization.js";

const shared = globalThis.ReadlaterContentNormalization;

if (!shared) throw new Error("Shared content normalizer failed to initialize");

export const normalizeProseWhitespace = shared.normalizeProseWhitespace;
export const normalizeMarkdownPreservingCode = shared.normalizeMarkdownPreservingCode;
export const markdownMetrics = shared.markdownMetrics;

export function htmlToMarkdown(html = "", baseUrl = "https://example.invalid/", options = {}) {
  const { document } = parseHTML(`<html><body>${html || ""}</body></html>`);
  return shared.serializeDom(document.body, { baseUrl, ...options }).markdown;
}

export function htmlToSemanticCapture(html = "", baseUrl = "https://example.invalid/", options = {}) {
  const { document } = parseHTML(`<html><body>${html || ""}</body></html>`);
  return shared.serializeDom(document.body, { baseUrl, ...options });
}

export function selectContentHtml(html = "", selectors = []) {
  const { document } = parseHTML(String(html || ""));
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element?.innerHTML) return element.innerHTML;
  }
  return "";
}
