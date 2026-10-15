import test from "node:test";
import assert from "node:assert/strict";
import { createTingwuProvider, isTingwuConfigured, tingwuConfig } from "../lib/tingwu.mjs";

const configuredEnv = {
  TINGWU_ACCESS_KEY_ID: "id",
  TINGWU_ACCESS_KEY_SECRET: "secret",
  TINGWU_APP_KEY: "app",
  TINGWU_POLL_MS: "7000"
};

test("Tingwu configuration supports explicit and official credential environment names", () => {
  assert.equal(isTingwuConfigured(configuredEnv), true);
  assert.equal(isTingwuConfigured({ ALIBABA_CLOUD_ACCESS_KEY_ID: "id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret", TINGWU_APP_KEY: "app" }), true);
  assert.equal(isTingwuConfigured({ TINGWU_ACCESS_KEY_ID: "id" }), false);
  assert.equal(tingwuConfig(configuredEnv).pollMs, 7000);
  assert.equal(createTingwuProvider({ env: configuredEnv }).name, "tingwu");
});
test("Tingwu provider submits offline transcription with a stable task key", async () => {
  let request;
  const provider = createTingwuProvider({
    env: configuredEnv,
    client: {
      async createTask(value) {
        request = value;
        return { body: { code: "0", data: { taskId: "task-123" } } };
      }
    }
  });
  assert.deepEqual(await provider.submit({ audioUrl: "https://cdn.example.com/audio.mp3", taskKey: "job-1" }), {
    providerTaskId: "task-123",
    hotwordPhraseId: ""
  });
  assert.equal(request.type, "offline");
  assert.equal(request.input.fileUrl, "https://cdn.example.com/audio.mp3");
  assert.equal(request.input.taskKey, "job_1");
  assert.equal(request.parameters.transcription.diarizationEnabled, true);
  assert.equal(request.parameters.transcription.diarization.speakerCount, 0);
  assert.equal(request.parameters.transcription.audioEventDetectionEnabled, true);
  assert.equal(request.parameters.transcription.outputLevel, 1);
});

test("Tingwu provider creates a temporary hotword list and applies interview speaker count", async () => {
  let phraseRequest;
  let taskRequest;
  const deleted = [];
  const provider = createTingwuProvider({
    env: configuredEnv,
    client: {
      async createTranscriptionPhrases(value) {
        phraseRequest = value;
        return { body: { code: "0", data: { phraseId: "phrase-123" } } };
      },
      async createTask(value) {
        taskRequest = value;
        return { body: { code: "0", data: { taskId: "task-with-hotwords" } } };
      },
      async deleteTranscriptionPhrases(value) { deleted.push(value); }
    }
  });
  assert.deepEqual(await provider.submit({
    audioUrl: "https://cdn.example.com/interview.m4a",
    taskKey: "job-interview",
    hotwords: ["Ambi", "Openclaw", "莫子皓"],
    speakerCount: 2
  }), {
    providerTaskId: "task-with-hotwords",
    hotwordPhraseId: "phrase-123"
  });
  assert.deepEqual(JSON.parse(phraseRequest.wordWeights), { Ambi: 3, Openclaw: 3, 莫子皓: 3 });
  assert.equal(taskRequest.parameters.transcription.phraseId, "phrase-123");
  assert.equal(taskRequest.parameters.transcription.diarization.speakerCount, 2);
  assert.equal(await provider.cleanupHotwords("phrase-123"), true);
  assert.deepEqual(deleted, ["phrase-123"]);
});

test("Tingwu provider releases a temporary hotword list when task creation fails", async () => {
  const deleted = [];
  const provider = createTingwuProvider({
    env: configuredEnv,
    client: {
      async createTranscriptionPhrases() {
        return { body: { code: "0", data: { phraseId: "phrase-failed" } } };
      },
      async createTask() { return { body: { code: "500", message: "quota" } }; },
      async deleteTranscriptionPhrases(value) { deleted.push(value); }
    }
  });
  await assert.rejects(
    provider.submit({ audioUrl: "https://cdn.example.com/audio.mp3", taskKey: "job-failed", hotwords: ["Ambi"] }),
    /quota/
  );
  assert.deepEqual(deleted, ["phrase-failed"]);
});

test("Tingwu speaker diarization can be disabled explicitly", async () => {
  let request;
  const provider = createTingwuProvider({
    env: { ...configuredEnv, TINGWU_DIARIZATION_ENABLED: "false" },
    client: {
      async createTask(value) {
        request = value;
        return { body: { code: "0", data: { taskId: "task-no-diarization" } } };
      }
    }
  });
  await provider.submit({ audioUrl: "https://cdn.example.com/audio.mp3", taskKey: "job-no-diarization" });
  assert.equal(request.parameters.transcription.diarizationEnabled, false);
  assert.equal(request.parameters.transcription.diarization, undefined);
});

test("Tingwu speaker count accepts auto or exactly two speakers", () => {
  assert.equal(tingwuConfig({ ...configuredEnv, TINGWU_SPEAKER_COUNT: "0" }).speakerCount, 0);
  assert.equal(tingwuConfig({ ...configuredEnv, TINGWU_SPEAKER_COUNT: "2" }).speakerCount, 2);
  assert.equal(tingwuConfig({ ...configuredEnv, TINGWU_SPEAKER_COUNT: "9" }).speakerCount, 0);
});

test("Tingwu provider normalizes task keys for stable upstream identifiers", async () => {
  let captured;
  const provider = createTingwuProvider({
    env: configuredEnv,
    client: {
      async createTask(request) {
        captured = request;
        return { body: { code: "0", data: { taskId: "task-safe" } } };
      }
    }
  });

  await provider.submit({ audioUrl: "https://cdn.example.com/audio.mp3", taskKey: "job-has-hyphens" });
  assert.equal(captured.input.taskKey, "job_has_hyphens");
});

test("Tingwu provider maps processing, completed, and failed states", async () => {
  let response = { body: { code: "0", data: { taskStatus: "ONGOING" } } };
  const provider = createTingwuProvider({
    env: configuredEnv,
    client: { async getTaskInfo() { return response; } }
  });
  assert.deepEqual(await provider.getStatus("task"), { status: "processing" });
  response = { body: { code: "0", data: { taskStatus: "COMPLETED", result: { transcription: "https://result.example/test.json" } } } };
  assert.deepEqual(await provider.getStatus("task"), { status: "completed", resultUrl: "https://result.example/test.json" });
  response = { body: { code: "0", data: { taskStatus: "FAILED", errorMessage: "bad audio" } } };
  assert.deepEqual(await provider.getStatus("task"), { status: "failed", error: "bad audio" });
});

test("Tingwu result downloader normalizes provider JSON", async () => {
  const provider = createTingwuProvider({
    env: configuredEnv,
    client: {},
    fetchImpl: async () => new Response(JSON.stringify({
      Transcription: { Paragraphs: [{ Words: [{ SentenceId: 1, Start: 0, End: 120, Text: "你好" }] }] }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });
  assert.deepEqual(await provider.fetchResult("https://result.example/test.json"), {
    segments: [{ startMs: 0, endMs: 120, text: "你好", speaker: "", paragraphIndex: 0 }],
    providerMetadata: { detectedLanguage: "", audioInfo: null, audioSegments: [] }
  });
});

test("Tingwu result downloader rejects a provider language mismatch", async () => {
  const provider = createTingwuProvider({
    env: configuredEnv,
    client: {},
    fetchImpl: async () => new Response(JSON.stringify({
      Transcription: {
        AudioInfo: { Language: "en" },
        Paragraphs: [{ Words: [{ SentenceId: 1, Start: 0, End: 120, Text: "Ni hao" }] }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });
  await assert.rejects(
    provider.fetchResult("https://result.example/wrong-language.json"),
    /请求 cn，结果 en/
  );
});
