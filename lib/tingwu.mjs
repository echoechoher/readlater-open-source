import * as TingwuSdk from "@alicloud/tingwu20230930";
import { Config } from "@alicloud/openapi-client";
import { normalizeTranscriptSegments } from "./transcription.mjs";

const TingwuClient = TingwuSdk.default?.default || TingwuSdk.default || TingwuSdk.Client;

export function tingwuConfig(env = process.env) {
  return {
    accessKeyId: env.TINGWU_ACCESS_KEY_ID || env.ALIBABA_CLOUD_ACCESS_KEY_ID || "",
    accessKeySecret: env.TINGWU_ACCESS_KEY_SECRET || env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || "",
    appKey: env.TINGWU_APP_KEY || "",
    endpoint: env.TINGWU_ENDPOINT || "tingwu.cn-beijing.aliyuncs.com",
    sourceLanguage: env.TINGWU_SOURCE_LANGUAGE || "cn",
    diarizationEnabled: String(env.TINGWU_DIARIZATION_ENABLED || "true").toLowerCase() !== "false",
    speakerCount: [0, 2].includes(Number(env.TINGWU_SPEAKER_COUNT)) ? Number(env.TINGWU_SPEAKER_COUNT) : 0,
    pollMs: Math.max(5000, Number(env.TINGWU_POLL_MS || 15000)),
    timeoutMs: Math.max(5000, Number(env.TINGWU_TIMEOUT_MS || 30000))
  };
}
export function isTingwuConfigured(env = process.env) {
  const config = tingwuConfig(env);
  return Boolean(config.accessKeyId && config.accessKeySecret && config.appKey);
}

export function createTingwuProvider({ env = process.env, client, fetchImpl = fetch } = {}) {
  const config = tingwuConfig(env);
  if (!config.accessKeyId || !config.accessKeySecret || !config.appKey) {
    throw new Error("通义听悟未配置，请设置 TINGWU_ACCESS_KEY_ID、TINGWU_ACCESS_KEY_SECRET 和 TINGWU_APP_KEY");
  }
  const sdkClient = client || new TingwuClient(new Config({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    endpoint: config.endpoint
  }));

  return {
    name: "tingwu",
    pollMs: config.pollMs,
    async submit({ audioUrl, taskKey }) {
      const safeTaskKey = String(taskKey || `readlater_${Date.now()}`)
        .replace(/[^A-Za-z0-9_]/g, "_")
        .slice(0, 64);
      const request = new TingwuSdk.CreateTaskRequest({
        appKey: config.appKey,
        type: "offline",
        input: new TingwuSdk.CreateTaskRequestInput({
          fileUrl: audioUrl,
          sourceLanguage: config.sourceLanguage,
          taskKey: safeTaskKey
        }),
        parameters: new TingwuSdk.CreateTaskRequestParameters({
          transcription: new TingwuSdk.CreateTaskRequestParametersTranscription({
            diarizationEnabled: config.diarizationEnabled,
            diarization: config.diarizationEnabled
              ? new TingwuSdk.CreateTaskRequestParametersTranscriptionDiarization({
                speakerCount: config.speakerCount
              })
              : undefined,
            // Offline transcription only needs final sentences. Intermediate
            // results increase noise and can duplicate partial recognition.
            outputLevel: 1
          })
        })
      });
      const response = await sdkClient.createTask(request);
      const body = response?.body || {};
      if (String(body.code ?? "0") !== "0" || !body.data?.taskId) {
        throw new Error(body.message || "通义听悟没有返回任务 ID");
      }
      return { providerTaskId: body.data.taskId };
    },
    async getStatus(providerTaskId) {
      const response = await sdkClient.getTaskInfo(providerTaskId);
      const body = response?.body || {};
      if (String(body.code ?? "0") !== "0") throw new Error(body.message || "通义听悟状态查询失败");
      const status = String(body.data?.taskStatus || "").toUpperCase();
      if (["FAILED", "INVALID"].includes(status)) {
        return { status: "failed", error: body.data?.errorMessage || body.message || "通义听悟任务失败" };
      }
      if (status !== "COMPLETED") return { status: "processing" };
      const resultUrl = body.data?.result?.transcription;
      if (!resultUrl) throw new Error("通义听悟任务已完成，但没有返回转写结果");
      return { status: "completed", resultUrl };
    },
    async fetchResult(resultUrl) {
      const response = await fetchImpl(resultUrl, { signal: AbortSignal.timeout(config.timeoutMs) });
      if (!response.ok) throw new Error(`下载通义听悟结果失败：HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > 50 * 1024 * 1024) throw new Error("通义听悟结果文件过大");
      const payload = await response.json();
      const detectedLanguage = String(payload?.Transcription?.AudioInfo?.Language || "").toLowerCase();
      if (
        detectedLanguage
        && ["cn", "en", "yue", "ja", "ko"].includes(config.sourceLanguage)
        && detectedLanguage !== config.sourceLanguage
      ) {
        throw new Error(`通义听悟返回了异常语种：请求 ${config.sourceLanguage}，结果 ${detectedLanguage}`);
      }
      const segments = normalizeTranscriptSegments(payload);
      if (!segments.length) throw new Error("通义听悟返回了空文稿");
      return segments;
    }
  };
}
