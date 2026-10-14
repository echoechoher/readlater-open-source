import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeRemoteUrl,
  isDirectAudioUrl,
  isPrivateAddress,
  isSupportedPodcastUrl,
  isXiaoyuzhouEpisodeUrl,
  parseXiaoyuzhouHtml,
  resolvePodcastUrl
} from "../lib/podcast.mjs";

const publicLookup = async () => [{ address: "203.0.113.10", family: 4 }];

test("podcast URL classifier only accepts Xiaoyuzhou episodes and public audio extensions", () => {
  assert.equal(isXiaoyuzhouEpisodeUrl("https://www.xiaoyuzhoufm.com/episode/abc"), true);
  assert.equal(isXiaoyuzhouEpisodeUrl("https://evil-xiaoyuzhoufm.com/episode/abc"), false);
  assert.equal(isXiaoyuzhouEpisodeUrl("https://www.xiaoyuzhoufm.com/podcast/abc"), false);
  assert.equal(isDirectAudioUrl("https://cdn.example.com/show/episode-1.MP3?token=1"), true);
  assert.equal(isDirectAudioUrl("file:///tmp/private.mp3"), false);
  assert.equal(isSupportedPodcastUrl("https://example.com/article"), false);
});
test("remote URL validation blocks loopback, private networks, credentials, and unsafe DNS", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.1.2", "192.168.1.2", "169.254.1.1", "::1", "fd00::1", "::ffff:7f00:1", "::ffff:c0a8:101"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  await assert.rejects(() => assertSafeRemoteUrl("http://localhost/audio.mp3"), /本机/);
  await assert.rejects(() => assertSafeRemoteUrl("http://127.0.0.1/audio.mp3"), /内网/);
  await assert.rejects(() => assertSafeRemoteUrl("https://user:pass@example.com/audio.mp3", { lookup: publicLookup }), /账号/);
  await assert.rejects(() => assertSafeRemoteUrl("https://example.com/audio.mp3", {
    lookup: async () => [{ address: "192.168.1.5", family: 4 }]
  }), /内网/);
  await assert.doesNotReject(() => assertSafeRemoteUrl("https://example.com/audio.mp3", { lookup: publicLookup }));
});

test("Xiaoyuzhou NEXT_DATA parser extracts normalized episode metadata", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        episode: {
          title: "Agent Harness 设计",
          mediaKey: "audio/test.m4a",
          duration: 3661,
          description: "一期测试播客",
          podcast: { title: "小议", image: { picUrl: "https://img.example/cover.jpg" } }
        }
      }
    }
  })}</script>`;
  assert.deepEqual(parseXiaoyuzhouHtml(html), {
    showName: "小议",
    title: "Agent Harness 设计",
    audioUrl: "https://media.xyzcdn.net/audio/test.m4a",
    coverUrl: "https://img.example/cover.jpg",
    durationSeconds: 3661,
    description: "一期测试播客"
  });
});

test("Xiaoyuzhou parser falls back to JSON-LD and parses ISO duration", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "PodcastEpisode",
    name: "Episode 8",
    audio: { contentUrl: "https://cdn.example.com/ep8.mp3" },
    partOfSeries: { name: "Example Show" },
    image: "https://cdn.example.com/cover.png",
    duration: "PT1H2M3S",
    description: "description"
  })}</script>`;
  assert.equal(parseXiaoyuzhouHtml(html).durationSeconds, 3723);
  assert.equal(parseXiaoyuzhouHtml(html).showName, "Example Show");
});

test("resolver validates every redirect before parsing and rejects an internal redirect", async () => {
  const fetchImpl = async () => new Response(null, {
    status: 302,
    headers: { location: "http://127.0.0.1/private" }
  });
  await assert.rejects(() => resolvePodcastUrl("https://www.xiaoyuzhoufm.com/episode/abc", {
    fetchImpl,
    lookup: publicLookup
  }), /内网/);
});

test("direct audio resolver creates metadata without downloading the media", async () => {
  let fetched = false;
  const podcast = await resolvePodcastUrl("https://cdn.example.com/show/agent-harness.mp3?token=abc", {
    lookup: publicLookup,
    fetchImpl: async () => { fetched = true; }
  });
  assert.equal(fetched, false);
  assert.equal(podcast.platform, "direct_audio");
  assert.equal(podcast.title, "agent harness");
});
