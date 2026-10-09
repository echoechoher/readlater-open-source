import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isPersistableWeChatMediaUrl,
  persistWeChatMedia
} from "../lib/media-persistence.mjs";

test("only persists allowlisted HTTPS WeChat image hosts", () => {
  assert.equal(isPersistableWeChatMediaUrl("https://mmbiz.qpic.cn/example.png"), true);
  assert.equal(isPersistableWeChatMediaUrl("http://mmbiz.qpic.cn/example.png"), false);
  assert.equal(isPersistableWeChatMediaUrl("https://127.0.0.1/private.png"), false);
  assert.equal(isPersistableWeChatMediaUrl("https://example.com/image.png"), false);
});

test("downloads WeChat images with referer and rewrites Markdown in place", async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), "readlater-media-"));
  const remoteUrl = "https://mmbiz.qpic.cn/example.png";
  let request = null;
  try {
    const result = await persistWeChatMedia({
      markdown: `上文\n\n![流程图](${remoteUrl})\n\n下文`,
      media: [{ type: "image", url: remoteUrl, alt: "流程图", width: 1200, height: 800 }],
      referer: "https://mp.weixin.qq.com/s/example",
      mediaDir,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(Buffer.from("fake-image"), {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }
    });

    assert.equal(request.url, remoteUrl);
    assert.equal(request.options.headers.Referer, "https://mp.weixin.qq.com/s/example");
    assert.equal(result.persisted.length, 1);
    assert.match(result.markdown, /!\[流程图\]\(\/media\/[a-f0-9]{64}\.png\)/);
    assert.equal(result.media[0].originalUrl, remoteUrl);
    assert.equal(result.media[0].persisted, true);
    const filename = result.media[0].url.split("/").pop();
    assert.equal(await readFile(join(mediaDir, filename), "utf8"), "fake-image");
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
});
