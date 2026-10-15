import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`);
      if (response.ok) return;
    } catch {
      // Keep waiting for startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("server did not start");
}

async function json(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  return { response, body: await response.json() };
}

test("podcast API covers import, job lifecycle, transcript storage, duplicate protection, and cancel", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "readlater-podcast-api-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      READLATER_DATA_DIR: dataDir,
      READLATER_PASSWORD: "",
      TINGWU_ACCESS_KEY_ID: "",
      TINGWU_ACCESS_KEY_SECRET: "",
      TINGWU_APP_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitForServer(baseUrl, child);

  const settings = await json(baseUrl, "/api/settings");
  assert.equal(settings.body.settings.transcription.enabled, true);
  assert.equal(settings.body.settings.transcription.serverCredentialsDetected, false);
  const workerHeaders = {
    Authorization: `Bearer ${settings.body.settings.workerToken}`,
    "X-Readlater-Worker-Id": "api-test-worker"
  };

  const imported = await json(baseUrl, "/api/inbox/url", {
    method: "POST",
    body: JSON.stringify({ url: "https://8.8.8.8/test-episode.mp3" })
  });
  assert.equal(imported.response.status, 200, stderr);
  assert.equal(imported.body.article.contentType, "podcast_episode");
  assert.equal(imported.body.article.transcription.status, "queued");
  const articleId = imported.body.article.id;

  const duplicate = await json(baseUrl, "/api/inbox/url", {
    method: "POST",
    body: JSON.stringify({ url: "https://8.8.8.8/test-episode.mp3" })
  });
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.article.id, articleId);

  const blockedDigest = await json(baseUrl, `/api/articles/${articleId}/digest-jobs`, {
    method: "POST",
    body: JSON.stringify({ mode: "sop_b_ai_marks" })
  });
  assert.equal(blockedDigest.response.status, 409);

  const claimed = await json(baseUrl, "/api/transcription-jobs/next", { headers: workerHeaders });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.body.job.stage, "submit");
  assert.ok(Array.isArray(claimed.body.job.hotwords));
  assert.equal(claimed.body.job.speakerCount, 0);
  const jobId = claimed.body.job.id;

  await json(baseUrl, `/api/transcription-jobs/${jobId}`, {
    method: "PATCH",
    headers: workerHeaders,
    body: JSON.stringify({
      status: "waiting",
      stage: "poll",
      providerTaskId: "provider-task-1",
      hotwordPhraseId: "phrase-1",
      nextRunAt: "2000-01-01T00:00:00.000Z"
    })
  });
  const reclaimed = await json(baseUrl, "/api/transcription-jobs/next", { headers: workerHeaders });
  assert.equal(reclaimed.body.job.id, jobId);
  assert.equal(reclaimed.body.job.stage, "poll");

  const completed = await json(baseUrl, `/api/transcription-jobs/${jobId}/result`, {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({
      providerMetadata: { detectedLanguage: "cn", audioInfo: { Duration: 1600 } },
      correctionMetadata: { provider: "venus", chunks: 1, correctedSegments: 1, failedChunks: 0 },
      segments: [
        { startMs: 0, endMs: 800, text: "第一句。" },
        { startMs: 800, endMs: 1600, text: "第二句。" }
      ]
    })
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.article.transcription.status, "completed");
  const duplicateResult = await json(baseUrl, `/api/transcription-jobs/${jobId}/result`, {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ segments: [{ startMs: 0, endMs: 1, text: "不应覆盖" }] })
  });
  assert.equal(duplicateResult.response.status, 200);
  assert.equal(duplicateResult.body.article.transcription.transcriptVersion, 1);

  const article = await json(baseUrl, `/api/articles/${articleId}`);
  assert.equal(article.body.article.contentText, "第一句。第二句。");
  assert.equal(article.body.article.transcription.segmentCount, 2);
  const transcript = await json(baseUrl, `/api/articles/${articleId}/transcript`);
  assert.deepEqual(transcript.body.segments.map((segment) => segment.text), ["第一句。", "第二句。"]);
  const transcriptFile = JSON.parse(await readFile(join(dataDir, "transcripts", articleId, "1.json"), "utf8"));
  assert.equal(transcriptFile.segments.length, 2);
  assert.equal(transcriptFile.providerMetadata.detectedLanguage, "cn");
  assert.equal(transcriptFile.correctionMetadata.correctedSegments, 1);

  await json(baseUrl, `/api/articles/${articleId}/highlights`, {
    method: "POST",
    body: JSON.stringify({ selectedText: "第一句", textStart: 0, textEnd: 3, prefix: "", suffix: "。" })
  });
  const protectedRetry = await json(baseUrl, `/api/articles/${articleId}/transcription/retry`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(protectedRetry.response.status, 409);

  const second = await json(baseUrl, "/api/inbox/url", {
    method: "POST",
    body: JSON.stringify({ url: "https://8.8.4.4/cancel-me.mp3" })
  });
  const secondClaim = await json(baseUrl, "/api/transcription-jobs/next", { headers: workerHeaders });
  await json(baseUrl, `/api/transcription-jobs/${secondClaim.body.job.id}`, {
    method: "PATCH",
    headers: workerHeaders,
    body: JSON.stringify({
      status: "waiting",
      stage: "poll",
      providerTaskId: "cancel-provider-task",
      hotwordPhraseId: "cancel-phrase",
      nextRunAt: "2100-01-01T00:00:00.000Z"
    })
  });
  const cancelled = await json(baseUrl, `/api/articles/${second.body.article.id}/transcription/cancel`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(cancelled.body.article.transcription.status, "cancelled");
  const lateProgress = await json(baseUrl, `/api/transcription-jobs/${secondClaim.body.job.id}`, {
    method: "PATCH",
    headers: workerHeaders,
    body: JSON.stringify({ status: "waiting", stage: "poll", providerTaskId: "too-late" })
  });
  assert.equal(lateProgress.response.status, 409);
  const cleanupClaim = await json(baseUrl, "/api/transcription-jobs/next", { headers: workerHeaders });
  assert.equal(cleanupClaim.body.job.id, secondClaim.body.job.id);
  assert.equal(cleanupClaim.body.job.stage, "cleanup");
  const cleanupDone = await json(baseUrl, `/api/transcription-jobs/${secondClaim.body.job.id}`, {
    method: "PATCH",
    headers: workerHeaders,
    body: JSON.stringify({ status: "cancelled", stage: "cleanup", hotwordPhraseId: "" })
  });
  assert.equal(cleanupDone.response.status, 200);

  const unsafe = await json(baseUrl, "/api/inbox/url", {
    method: "POST",
    body: JSON.stringify({ url: "http://127.0.0.1/private.mp3" })
  });
  assert.equal(unsafe.response.status, 400);
  assert.match(unsafe.body.error, /内网/);

  const concurrentUrls = ["https://9.9.9.9/concurrent-a.mp3", "https://208.67.222.222/concurrent-b.mp3"];
  await Promise.all(concurrentUrls.map((url) => json(baseUrl, "/api/inbox/url", {
    method: "POST",
    body: JSON.stringify({ url })
  })));
  const list = await json(baseUrl, "/api/articles");
  assert.ok(concurrentUrls.every((url) => list.body.articles.some((articleSummary) => articleSummary.url === url)));
  await assert.doesNotReject(async () => JSON.parse(await readFile(join(dataDir, "readlater.json"), "utf8")));
});
