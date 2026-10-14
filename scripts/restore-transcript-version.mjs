import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { transcriptToDocument } from "../lib/transcription.mjs";

const [articleId, rawVersion, ...flags] = process.argv.slice(2);
const version = Number(rawVersion);
const stripSpeakers = flags.includes("--strip-speakers");

if (!articleId || !Number.isInteger(version) || version < 1) {
  console.error("Usage: node scripts/restore-transcript-version.mjs <article-id> <version> [--strip-speakers]");
  process.exit(1);
}

const dataDir = resolve(process.env.READLATER_DATA_DIR || join(import.meta.dirname, "../data"));
const dbPath = join(dataDir, "readlater.json");
const transcriptPath = join(dataDir, "transcripts", articleId, `${version}.json`);
const db = JSON.parse(await readFile(dbPath, "utf8"));
const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
const article = (db.articles || []).find((entry) => entry.id === articleId);

if (!article) throw new Error(`Article not found: ${articleId}`);
if (article.highlights?.length) throw new Error("Cannot restore a transcript after highlights have been created");
if (!Array.isArray(transcript.segments) || !transcript.segments.length) throw new Error("Transcript has no segments");

const segments = stripSpeakers
  ? transcript.segments.map((segment) => ({ ...segment, speaker: "" }))
  : transcript.segments;
const document = transcriptToDocument(segments);
const timestamp = new Date().toISOString();
const relativeTranscriptPath = `transcripts/${articleId}/${version}.json`;

article.contentText = document.contentText;
article.contentMarkdown = "";
article.excerpt = document.contentText.slice(0, 220);
article.fetchStatus = "ready";
article.contentVersion = Number(article.contentVersion || 0) + 1;
article.transcription = {
  ...(article.transcription || {}),
  status: "completed",
  provider: transcript.provider || article.transcription?.provider || "tingwu",
  providerTaskId: transcript.providerTaskId || "",
  transcriptVersion: version,
  transcriptPath: relativeTranscriptPath,
  segmentCount: segments.length,
  error: "",
  restoredAt: timestamp,
  updatedAt: timestamp
};
article.updatedAt = timestamp;

const backupPath = `${dbPath}.before-transcript-restore-${Date.now()}.bak`;
const temporaryPath = join(dirname(dbPath), `.readlater-restore-${randomUUID()}.tmp`);
await copyFile(dbPath, backupPath);
await writeFile(temporaryPath, JSON.stringify(db), { mode: 0o600 });
await rename(temporaryPath, dbPath);

console.log(JSON.stringify({ articleId, version, stripSpeakers, backupPath }));
