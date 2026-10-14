export async function advanceTranscriptionJob(job, provider, { now = () => Date.now() } = {}) {
  const terminalError = (message) => {
    const error = new Error(message);
    error.retryable = false;
    return error;
  };
  const nextRunAt = () => new Date(now() + provider.pollMs).toISOString();
  if (job.stage === "submit") {
    if (job.attempts > 1 && !job.providerTaskId) {
      throw new Error("上次提交在确认任务 ID 前中断；为避免重复计费，请手动重试");
    }
    const submitted = await provider.submit({ audioUrl: job.audioUrl, taskKey: job.id });
    if (!submitted?.providerTaskId) throw new Error("转写服务没有返回任务 ID");
    return {
      type: "update",
      body: {
        status: "waiting",
        stage: "poll",
        providerTaskId: submitted.providerTaskId,
        nextRunAt: nextRunAt(),
        errorAttempts: 0,
        error: ""
      }
    };
  }

  if (job.stage === "poll") {
    if (!job.providerTaskId) throw new Error("转写任务缺少供应商任务 ID");
    const status = await provider.getStatus(job.providerTaskId);
    if (status.status === "processing") {
      return {
        type: "update",
        body: {
          status: "waiting",
          stage: "poll",
          nextRunAt: nextRunAt(),
          errorAttempts: 0,
          error: ""
        }
      };
    }
    if (status.status === "failed") throw terminalError(status.error || "转写任务失败");
    if (status.status !== "completed" || !status.resultUrl) throw terminalError("转写服务返回了未知状态");
    const segments = await provider.fetchResult(status.resultUrl);
    return { type: "complete", body: { segments } };
  }

  throw new Error(`未知转写阶段：${job.stage}`);
}
