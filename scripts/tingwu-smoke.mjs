import { resolve } from "node:path";
import { createTingwuProvider } from "../lib/tingwu.mjs";

if (process.env.TINGWU_CREDENTIALS_FILE) {
  process.loadEnvFile(resolve(process.env.TINGWU_CREDENTIALS_FILE));
}

const audioUrl = process.argv.slice(2).find((value) => value !== "--") || process.env.TINGWU_SMOKE_AUDIO_URL;
if (!audioUrl) {
  console.error("Usage: pnpm smoke:tingwu -- <public-audio-url>");
  process.exit(1);
}

const provider = createTingwuProvider();
const timeoutAt = Date.now() + Number(process.env.TINGWU_SMOKE_TIMEOUT_MS || 10 * 60 * 1000);
const { providerTaskId } = await provider.submit({
  audioUrl,
  taskKey: `readlater_smoke_${Date.now()}`
});
console.log(`[tingwu-smoke] submitted ${providerTaskId}`);

while (Date.now() < timeoutAt) {
  const status = await provider.getStatus(providerTaskId);
  console.log(`[tingwu-smoke] ${status.status}`);
  if (status.status === "failed") throw new Error(status.error || "Tingwu task failed");
  if (status.status === "completed") {
    const segments = await provider.fetchResult(status.resultUrl);
    const last = segments.at(-1);
    console.log(`[tingwu-smoke] completed: ${segments.length} segments, ${last?.endMs || 0} ms`);
    process.exit(0);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, provider.pollMs));
}

throw new Error("Tingwu smoke test timed out");
