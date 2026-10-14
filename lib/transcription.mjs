export const TRANSCRIPTION_ACTIVE_STATUSES = new Set(["queued", "processing"]);

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

  return segments
    .filter((segment) => segment.text)
    .map((segment) => ({
      ...segment,
      startMs: Math.max(0, segment.startMs),
      endMs: Math.max(segment.startMs, segment.endMs)
    }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
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
