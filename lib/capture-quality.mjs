import { markdownMetrics } from "./content-normalization.mjs";

function count(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizedMetrics(value = {}) {
  return {
    textLength: count(value.textLength),
    headings: count(value.headings),
    images: count(value.images),
    tables: count(value.tables),
    codeBlocks: count(value.codeBlocks),
    listItems: count(value.listItems)
  };
}

export function articleContentMetrics(article = {}) {
  const markdown = markdownMetrics(article.contentMarkdown || "");
  return {
    ...markdown,
    textLength: Math.max(
      markdown.textLength,
      String(article.contentText || "").replace(/\s+/g, "").length
    ),
    images: Math.max(markdown.images, Array.isArray(article.media) ? article.media.filter((item) => item?.type === "image").length : 0)
  };
}

export function evaluateCaptureQuality({ captureMetrics, contentText = "", contentMarkdown = "", mediaPersistence = null } = {}) {
  const source = normalizedMetrics(captureMetrics?.source);
  const output = normalizedMetrics({
    ...markdownMetrics(contentMarkdown),
    textLength: Math.max(
      markdownMetrics(contentMarkdown).textLength,
      String(contentText || "").replace(/\s+/g, "").length
    )
  });
  const issues = [];
  const warnings = [];
  if (source.textLength >= 500 && output.textLength < source.textLength * 0.85) issues.push("text_loss");
  if (source.tables > output.tables) issues.push("table_loss");
  if (source.images > output.images) issues.push("image_loss");
  if (source.headings > output.headings) issues.push("heading_loss");
  if (source.codeBlocks > output.codeBlocks) issues.push("code_block_loss");
  if (source.listItems > 0 && output.listItems < source.listItems * 0.8) issues.push("list_loss");
  if (mediaPersistence?.failed?.length) warnings.push("media_persistence_failed");
  if (!output.textLength && !output.images) issues.push("empty_capture");
  return {
    status: issues.length ? "needs_review" : "ready",
    score: Math.max(0, 100 - issues.length * 20 - warnings.length * 5),
    issues,
    warnings,
    source,
    output
  };
}

function structuralScore(metrics) {
  return Math.min(metrics.textLength, 30000) / 1000
    + metrics.headings * 1.5
    + metrics.images * 4
    + metrics.tables * 6
    + metrics.codeBlocks * 2
    + Math.min(metrics.listItems, 40) * 0.2;
}

export function shouldPreferCapturedContent(existing = {}, incoming = {}) {
  const incomingMetrics = articleContentMetrics(incoming);
  const existingMetrics = articleContentMetrics(existing);
  if (!existingMetrics.textLength && !existingMetrics.images) return true;
  if (!incomingMetrics.textLength && !incomingMetrics.images) return false;

  const existingVersion = count(existing.contentVersion);
  const incomingVersion = count(incoming.contentVersion);
  const incomingQuality = incoming.captureQuality || evaluateCaptureQuality(incoming);

  if (incomingQuality.issues?.length && existing.fetchStatus === "ready") {
    const noTextGain = incomingMetrics.textLength <= existingMetrics.textLength * 1.05;
    const noStructureGain = structuralScore(incomingMetrics) <= structuralScore(existingMetrics);
    if (noTextGain && noStructureGain) return false;
  }

  if (existingVersion >= 3 && incomingVersion >= 3) {
    if (incomingMetrics.textLength < existingMetrics.textLength * 0.9) return false;
    if (incomingMetrics.images < existingMetrics.images) return false;
    if (incomingMetrics.tables < existingMetrics.tables) return false;
  }

  const incomingScore = structuralScore(incomingMetrics);
  const existingScore = structuralScore(existingMetrics);
  if (incomingVersion > existingVersion && incomingScore >= existingScore * 0.8) return true;
  if (incomingScore >= existingScore) return true;
  return incomingMetrics.textLength > existingMetrics.textLength * 1.15;
}
