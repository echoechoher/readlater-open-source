import test from "node:test";
import assert from "node:assert/strict";
import { advanceTranscriptionJob } from "../lib/transcription-worker.mjs";

const fixedNow = () => new Date("2026-01-01T00:00:00.000Z").getTime();

test("transcription worker submits once and schedules provider polling", async () => {
  let submitted;
  const outcome = await advanceTranscriptionJob({
    id: "job-1",
    stage: "submit",
    attempts: 1,
    audioUrl: "https://example.com/audio.mp3"
  }, {
    pollMs: 15000,
    async submit(input) {
      submitted = input;
      return { providerTaskId: "provider-1" };
    }
  }, { now: fixedNow });
  assert.deepEqual(submitted, { audioUrl: "https://example.com/audio.mp3", taskKey: "job-1" });
  assert.deepEqual(outcome, {
    type: "update",
    body: {
      status: "waiting",
      stage: "poll",
      providerTaskId: "provider-1",
      nextRunAt: "2026-01-01T00:00:15.000Z",
      errorAttempts: 0,
      error: ""
    }
  });
});
test("transcription worker polls without resubmitting and returns completed segments", async () => {
  let submitCalls = 0;
  const provider = {
    pollMs: 5000,
    async submit() { submitCalls += 1; },
    async getStatus() { return { status: "completed", resultUrl: "https://result.example/transcript.json" }; },
    async fetchResult() { return [{ startMs: 0, endMs: 100, text: "完成" }]; }
  };
  const outcome = await advanceTranscriptionJob({ id: "job-2", stage: "poll", providerTaskId: "provider-2" }, provider, { now: fixedNow });
  assert.equal(submitCalls, 0);
  assert.deepEqual(outcome, { type: "complete", body: { segments: [{ startMs: 0, endMs: 100, text: "完成" }] } });
});

test("transcription worker reschedules processing tasks and refuses uncertain duplicate submission", async () => {
  const provider = {
    pollMs: 5000,
    async getStatus() { return { status: "processing" }; }
  };
  const outcome = await advanceTranscriptionJob({ id: "job-3", stage: "poll", providerTaskId: "provider-3" }, provider, { now: fixedNow });
  assert.equal(outcome.body.nextRunAt, "2026-01-01T00:00:05.000Z");
  await assert.rejects(() => advanceTranscriptionJob({ id: "job-4", stage: "submit", attempts: 2 }, provider), /避免重复计费/);
});

test("transcription worker marks an explicit provider failure as terminal", async () => {
  const provider = {
    pollMs: 5000,
    async getStatus() { return { status: "failed", error: "File cannot be read." }; }
  };
  await assert.rejects(
    () => advanceTranscriptionJob({ id: "job-5", stage: "poll", providerTaskId: "provider-5" }, provider),
    (error) => error.message === "File cannot be read." && error.retryable === false
  );
});
