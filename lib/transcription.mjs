export const TRANSCRIPTION_ACTIVE_STATUSES = new Set(["queued", "processing"]);

const HOTWORD_LIMIT = 80;
const HOTWORD_MAX_CHARACTERS = 10;
const ENGLISH_HOTWORD_STOPWORDS = new Set([
  "and", "are", "audio", "base", "episode", "for", "form", "from", "gang", "happen",
  "https", "into", "made", "my", "of", "part", "podcast", "share", "the", "this",
  "that", "to", "with", "you", "your"
]);

function normalizeHotword(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^[\s·•._-]+|[\s·•._-]+$/gu, "");
}

function isValidHotword(value) {
  if (!value || [...value].length < 2 || [...value].length > HOTWORD_MAX_CHARACTERS) return false;
  if (!/^[\p{Script=Han}A-Za-z0-9]+$/u.test(value)) return false;
  if (/^[A-Za-z]+$/u.test(value) && ENGLISH_HOTWORD_STOPWORDS.has(value.toLowerCase())) return false;
  return !/^\d+$/u.test(value);
}

/**
 * Builds a small, high-signal Tingwu vocabulary from episode metadata. The
 * provider caps each phrase at ten characters, so descriptions are treated as
 * a source of product/person names rather than sent as free-form context.
 */
export function extractTranscriptionHotwords({ title = "", showName = "", description = "" } = {}) {
  const sources = [title, showName, description].map((value) => String(value || ""));
  const candidates = [];
  const add = (value) => {
    const normalized = normalizeHotword(value);
    if (isValidHotword(normalized)) candidates.push(normalized);
  };

  add(showName);
  for (const source of sources) {
    const scanSource = source.replace(/https?:\/\/\S+/gu, " ");
    for (const match of scanSource.matchAll(/\b[A-Za-z][A-Za-z0-9]{1,9}\b/gu)) add(match[0]);
    for (const match of scanSource.matchAll(/\b\d{1,3}[\p{Script=Han}]{1,7}\b/gu)) add(match[0]);
    for (const match of scanSource.matchAll(/(?:创始人|联合创始人|嘉宾|导游|珍藏|制作人|剪辑)[：:\s]*([\p{Script=Han}]{2,4})/gu)) add(match[1]);
    for (const match of scanSource.matchAll(/([\p{Script=Han}]{2,4})[，,]\s*[A-Za-z][A-Za-z0-9]{1,9}\s*创始人/gu)) add(match[1]);
  }

  const seen = new Set();
  return candidates.filter((value) => {
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, HOTWORD_LIMIT);
}

export function inferTranscriptionSpeakerCount({ title = "", description = "" } = {}) {
  return /对谈|访谈|采访|嘉宾|专访|主持人/u.test(`${title}\n${description}`) ? 2 : 0;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
export function normalizeTranscriptSegments(payload = {}) {
  const paragraphs = payload?.Transcription?.Paragraphs
    || payload?.transcription?.paragraphs
    || payload?.Paragraphs
    || [];
  const segments = [];
  const audioSegments = payload?.Transcription?.AudioSegments
    || payload?.transcription?.audioSegments
    || payload?.AudioSegments
    || [];
  const speechRanges = Array.isArray(audioSegments) ? audioSegments.map((segment) => ({
    startMs: number(Array.isArray(segment) ? segment[0] : segment?.Start ?? segment?.start),
    endMs: number(Array.isArray(segment) ? segment[1] : segment?.End ?? segment?.end)
  })).filter((segment) => segment.endMs > segment.startMs) : [];

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    const words = paragraph?.Words || paragraph?.words || [];
    if (!words.length) {
      const text = String(paragraph?.Text || paragraph?.text || "").trim();
      if (text) {
        segments.push({
          startMs: number(paragraph?.Start ?? paragraph?.start),
          endMs: number(paragraph?.End ?? paragraph?.end),
          text,
          speaker: String(paragraph?.SpeakerId ?? paragraph?.speaker ?? ""),
          paragraphIndex
        });
      }
      continue;
    }

    let currentId;
    let currentWords = [];
    const flush = () => {
      if (!currentWords.length) return;
      const text = currentWords.map((word) => String(word.Text ?? word.text ?? "")).join("").trim();
      if (text) {
        const speakerWord = currentWords.find((word) => word.SpeakerId != null || word.speaker != null);
        segments.push({
          startMs: number(currentWords[0].Start ?? currentWords[0].start),
          endMs: number(currentWords.at(-1).End ?? currentWords.at(-1).end),
          text,
          speaker: String(speakerWord?.SpeakerId ?? speakerWord?.speaker ?? paragraph?.SpeakerId ?? ""),
          paragraphIndex
        });
      }
      currentWords = [];
    };

    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const sentenceId = word.SentenceId ?? word.sentenceId ?? `paragraph-${segments.length}`;
      if (currentWords.length && sentenceId !== currentId) flush();
      currentId = sentenceId;
      currentWords.push(word);
    }
    flush();
  }

  const normalized = segments
    .filter((segment) => segment.text)
    .filter((segment) => !speechRanges.length || speechRanges.some((range) => (
      segment.endMs > range.startMs && segment.startMs < range.endMs
    )))
    .map((segment) => ({
      ...segment,
      startMs: Math.max(0, segment.startMs),
      endMs: Math.max(segment.startMs, segment.endMs)
    }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  const detectedLanguage = String(payload?.Transcription?.AudioInfo?.Language || "").toLowerCase();
  if (detectedLanguage === "cn" && normalized[0]?.startMs < 5000) {
    const speechIndex = normalized.findIndex((segment) => segment.startMs >= 15000);
    const intro = speechIndex > 0 ? normalized.slice(0, speechIndex) : [];
    const introText = intro.map((segment) => segment.text).join("");
    const visibleCharacters = [...introText].filter((character) => /[\p{L}\p{N}]/u.test(character));
    const latinCharacters = visibleCharacters.filter((character) => /[A-Za-z]/u.test(character));
    const longGap = speechIndex > 0 && normalized[speechIndex].startMs - intro.at(-1).endMs >= 8000;
    if (intro.length && longGap && latinCharacters.length / Math.max(1, visibleCharacters.length) >= 0.7) {
      return normalized.slice(speechIndex);
    }
  }
  return normalized;
}

export function sanitizeTranscriptSegments(value = []) {
  if (!Array.isArray(value)) throw new Error("转写结果格式无效");
  return value.slice(0, 100000).map((segment) => {
    const paragraphIndex = Number(segment?.paragraphIndex);
    return {
      startMs: Math.max(0, Math.round(number(segment?.startMs ?? segment?.start))),
      endMs: Math.max(0, Math.round(number(segment?.endMs ?? segment?.end))),
      text: String(segment?.text || "").trim().slice(0, 10000),
      speaker: String(segment?.speaker || "").slice(0, 120),
      ...(Number.isInteger(paragraphIndex) && paragraphIndex >= 0 ? { paragraphIndex } : {})
    };
  }).filter((segment) => segment.text).map((segment) => ({
    ...segment,
    endMs: Math.max(segment.startMs, segment.endMs)
  })).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function transcriptTimestamp(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(number(milliseconds) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function joinTranscriptText(current, next) {
  const separator = current && /[A-Za-z0-9]$/u.test(current) && /^[A-Za-z0-9]/u.test(next) ? " " : "";
  return `${current}${separator}${next}`;
}

export function transcriptToDocument(segments = [], {
  paragraphCharacters = 240,
  minimumParagraphCharacters = 80,
  silenceGapMs = 2000
} = {}) {
  const blocks = [];
  const speakerLabels = new Map();
  let current = "";
  let previousSegment = null;
  let currentSpeaker = "";

  const flush = () => {
    if (current) blocks.push(current);
    current = "";
  };
  const speakerLabel = (speaker) => {
    if (!speakerLabels.has(speaker)) speakerLabels.set(speaker, `说话人 ${speakerLabels.size + 1}`);
    return speakerLabels.get(speaker);
  };

  for (const segment of sanitizeTranscriptSegments(segments)) {
    const effectiveSpeaker = segment.speaker || currentSpeaker;
    const speakerChanged = Boolean(previousSegment && effectiveSpeaker && currentSpeaker && effectiveSpeaker !== currentSpeaker);
    const silenceBreak = Boolean(previousSegment && segment.startMs - previousSegment.endMs >= silenceGapMs);
    const providerParagraphBreak = Boolean(
      previousSegment
      && Number.isInteger(segment.paragraphIndex)
      && Number.isInteger(previousSegment.paragraphIndex)
      && segment.paragraphIndex !== previousSegment.paragraphIndex
      && current.length >= minimumParagraphCharacters
    );

    if (!previousSegment && effectiveSpeaker) {
      blocks.push(`${speakerLabel(effectiveSpeaker)} · ${transcriptTimestamp(segment.startMs)}`);
    } else if (speakerChanged) {
      flush();
      blocks.push(`${speakerLabel(effectiveSpeaker)} · ${transcriptTimestamp(segment.startMs)}`);
    } else if (silenceBreak || providerParagraphBreak) {
      flush();
    }

    const next = joinTranscriptText(current, segment.text);
    if (current && next.length > paragraphCharacters) {
      flush();
      current = segment.text;
    } else {
      current = next;
    }
    currentSpeaker = effectiveSpeaker;
    previousSegment = segment;
  }
  flush();
  const contentText = blocks.join("\n\n");
  return { contentText, contentMarkdown: contentText };
}

export function createTranscriptChunks(value = "", { maxCharacters = 12000, overlapCharacters = 400 } = {}) {
  const text = String(value || "").trim();
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxCharacters) {
      if (current) chunks.push(current);
      current = "";
      for (let offset = 0; offset < paragraph.length; offset += Math.max(1, maxCharacters - overlapCharacters)) {
        chunks.push(paragraph.slice(offset, offset + maxCharacters));
      }
      continue;
    }
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && next.length > maxCharacters) {
      chunks.push(current);
      const overlap = current.slice(Math.max(0, current.length - overlapCharacters));
      current = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function claimNextTranscriptionJob(jobs = [], {
  workerId,
  now = new Date(),
  leaseMs = 120000
} = {}) {
  const nowMs = now.getTime();
  const job = jobs
    .filter((entry) => {
      if (["queued", "waiting"].includes(entry.status)) {
        return !entry.nextRunAt || new Date(entry.nextRunAt).getTime() <= nowMs;
      }
      return entry.status === "running"
        && entry.leaseExpiresAt
        && new Date(entry.leaseExpiresAt).getTime() <= nowMs;
    })
    .sort((left, right) => new Date(left.nextRunAt || left.createdAt) - new Date(right.nextRunAt || right.createdAt))[0];
  if (!job) return null;
  job.status = "running";
  job.workerId = workerId;
  job.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
  job.attempts = Number(job.attempts || 0) + 1;
  job.updatedAt = now.toISOString();
  return job;
}
