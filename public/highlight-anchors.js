const TEXT_NODE = 3;
const SHOW_TEXT = 4;

function isReadableTextNode(node) {
  if (!node?.nodeValue || !node.nodeValue.trim()) return false;
  const parent = node.parentElement;
  return !parent?.closest?.("script, style, .translation-line");
}

export function buildTextIndex(root) {
  if (!root) return { text: "", entries: [] };
  const document = root.ownerDocument || root;
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  const entries = [];
  let text = "";
  let node;
  while ((node = walker.nextNode())) {
    if (!isReadableTextNode(node)) continue;
    const start = text.length;
    text += node.nodeValue;
    entries.push({ node, start, end: text.length });
  }
  return { text, entries };
}

function boundaryOffset(root, container, offset, index) {
  if (container?.nodeType === TEXT_NODE) {
    const entry = index.entries.find((candidate) => candidate.node === container);
    if (entry) return entry.start + Math.max(0, Math.min(offset, container.nodeValue.length));
  }

  const document = root.ownerDocument;
  if (!document?.createRange) return null;
  let total = 0;
  for (const entry of index.entries) {
    const probe = document.createRange();
    probe.selectNodeContents(entry.node);
    try {
      const comparison = probe.comparePoint(container, offset);
      if (comparison === 1) total = entry.end;
      else if (comparison === -1) break;
    } catch {
      return null;
    }
  }
  return total;
}

export function anchorFromRange(root, range, contextLength = 80) {
  if (!root || !range) return null;
  const index = buildTextIndex(root);
  let start = boundaryOffset(root, range.startContainer, range.startOffset, index);
  let end = boundaryOffset(root, range.endContainer, range.endOffset, index);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) return null;

  const raw = index.text.slice(start, end);
  const leading = raw.match(/^\s*/u)?.[0].length || 0;
  const trailing = raw.match(/\s*$/u)?.[0].length || 0;
  start += leading;
  end -= trailing;
  if (start >= end) return null;

  return {
    anchorVersion: 2,
    textStart: start,
    textEnd: end,
    selectedText: index.text.slice(start, end),
    prefix: index.text.slice(Math.max(0, start - contextLength), start),
    suffix: index.text.slice(end, end + contextLength)
  };
}

function commonSuffixLength(left = "", right = "") {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[left.length - 1 - length] === right[right.length - 1 - length]) length += 1;
  return length;
}

function commonPrefixLength(left = "", right = "") {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}

function allOccurrences(raw, target) {
  const positions = [];
  if (!target) return positions;
  let cursor = 0;
  while (cursor <= raw.length - target.length) {
    const start = raw.indexOf(target, cursor);
    if (start < 0) break;
    positions.push({ start, end: start + target.length });
    cursor = start + Math.max(1, target.length);
  }
  return positions;
}

function normalizeWithRefs(value, compact = false) {
  let text = "";
  const refs = [];
  let lastWasSpace = true;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/u.test(character)) {
      if (!compact && !lastWasSpace) {
        text += " ";
        refs.push(index);
      }
      lastWasSpace = true;
      continue;
    }
    text += character;
    refs.push(index);
    lastWasSpace = false;
  }
  if (!compact && text.endsWith(" ")) {
    text = text.slice(0, -1);
    refs.pop();
  }
  return { text, refs };
}

function chooseByContext(raw, candidates, anchor) {
  if (candidates.length <= 1) return candidates[0] || null;
  const prefix = String(anchor.prefix || "");
  const suffix = String(anchor.suffix || "");
  return candidates
    .map((candidate) => {
      const before = raw.slice(Math.max(0, candidate.start - prefix.length), candidate.start);
      const after = raw.slice(candidate.end, candidate.end + suffix.length);
      return {
        ...candidate,
        score: commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix)
      };
    })
    .sort((left, right) => right.score - left.score || left.start - right.start)[0];
}

export function locateTextAnchor(raw, anchor = {}) {
  const selectedText = String(anchor.selectedText || anchor.text || "");
  const positioned = {
    start: Number(anchor.textStart),
    end: Number(anchor.textEnd)
  };
  if (
    Number.isInteger(positioned.start)
    && Number.isInteger(positioned.end)
    && positioned.start >= 0
    && positioned.end > positioned.start
    && positioned.end <= raw.length
    && (!selectedText || raw.slice(positioned.start, positioned.end) === selectedText)
  ) {
    return positioned;
  }

  const exact = chooseByContext(raw, allOccurrences(raw, selectedText), anchor);
  if (exact) return { start: exact.start, end: exact.end };

  const normalizedTarget = normalizeWithRefs(selectedText).text;
  if (normalizedTarget) {
    const normalizedRaw = normalizeWithRefs(raw);
    const match = chooseByContext(
      normalizedRaw.text,
      allOccurrences(normalizedRaw.text, normalizedTarget),
      {}
    );
    if (match) {
      return {
        start: normalizedRaw.refs[match.start],
        end: normalizedRaw.refs[match.end - 1] + 1
      };
    }
  }

  const compactTarget = normalizeWithRefs(selectedText, true).text;
  if (!compactTarget) return null;
  const compactRaw = normalizeWithRefs(raw, true);
  const compactMatch = allOccurrences(compactRaw.text, compactTarget)[0];
  if (!compactMatch) return null;
  return {
    start: compactRaw.refs[compactMatch.start],
    end: compactRaw.refs[compactMatch.end - 1] + 1
  };
}

export function textSegmentsForAnchor(root, anchor) {
  const index = buildTextIndex(root);
  const position = locateTextAnchor(index.text, anchor);
  if (!position) return [];
  return index.entries.flatMap((entry) => {
    const start = Math.max(position.start, entry.start);
    const end = Math.min(position.end, entry.end);
    if (start >= end) return [];
    return [{
      textNode: entry.node,
      start: start - entry.start,
      end: end - entry.start
    }];
  });
}

export function applyTextAnchorMark(root, anchor, { className = "saved-highlight", highlightId = "" } = {}) {
  const segments = textSegmentsForAnchor(root, anchor);
  segments.reverse().forEach(({ textNode, start, end }) => {
    if (!textNode.parentNode) return;
    const document = textNode.ownerDocument;
    const value = textNode.nodeValue;
    const fragment = document.createDocumentFragment();
    if (start > 0) fragment.append(document.createTextNode(value.slice(0, start)));
    const mark = document.createElement("mark");
    mark.className = className;
    if (highlightId) mark.dataset.highlightId = highlightId;
    mark.textContent = value.slice(start, end);
    fragment.append(mark);
    if (end < value.length) fragment.append(document.createTextNode(value.slice(end)));
    textNode.parentNode.replaceChild(fragment, textNode);
  });
  return segments.length;
}

export function unwrapMarks(root, selector) {
  root?.querySelectorAll?.(selector).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize?.();
  });
}
