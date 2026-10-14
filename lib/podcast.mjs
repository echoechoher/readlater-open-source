import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, extname } from "node:path";

const XIAOYUZHOU_HOST = "xiaoyuzhoufm.com";
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"]);
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function isAllowedXiaoyuzhouHost(hostname = "") {
  const host = hostname.toLowerCase();
  return host === XIAOYUZHOU_HOST || host.endsWith(`.${XIAOYUZHOU_HOST}`);
}
export function isXiaoyuzhouEpisodeUrl(value = "") {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && isAllowedXiaoyuzhouHost(url.hostname)
      && url.pathname.startsWith("/episode/");
  } catch {
    return false;
  }
}

export function isDirectAudioUrl(value = "") {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && AUDIO_EXTENSIONS.has(extname(url.pathname).toLowerCase());
  } catch {
    return false;
  }
}

export function isSupportedPodcastUrl(value = "") {
  return isXiaoyuzhouEpisodeUrl(value) || isDirectAudioUrl(value);
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("::ffff:127.")
    || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.");
}

export function isPrivateAddress(address = "") {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export async function assertSafeRemoteUrl(value, { lookup = dnsLookup } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("播客链接不是有效 URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("播客链接只支持 HTTP 或 HTTPS");
  if (url.username || url.password) throw new Error("播客链接不能包含账号信息");
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("播客链接不能指向本机");

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isPrivateAddress(hostname)) throw new Error("播客链接不能指向内网地址");
    return url;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("无法解析播客链接域名");
  }
  if (!addresses?.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("播客链接不能指向内网地址");
  }
  return url;
}

async function fetchPublicUrl(value, { fetchImpl = fetch, lookup = dnsLookup, timeoutMs = 15000, maxRedirects = 4 } = {}) {
  let current = value;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    await assertSafeRemoteUrl(current, { lookup });
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("播客页面返回了无目标的重定向");
      current = new URL(location, current).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("播客链接重定向次数过多");
}

function parseDuration(value) {
  if (Number.isFinite(Number(value))) return Math.max(0, Math.round(Number(value)));
  const match = String(value || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return 0;
  return Math.round(Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
}

function jsonLdEpisode(value) {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const nested = Array.isArray(candidate["@graph"]) ? candidate["@graph"] : [];
    const result = jsonLdEpisode(nested);
    if (result) return result;
    const audio = typeof candidate.audio === "string" ? candidate.audio : candidate.audio?.contentUrl;
    if (candidate.name && audio) {
      return {
        showName: candidate.partOfSeries?.name || candidate.partOfSeries?.headline || "",
        title: candidate.name,
        audioUrl: audio,
        coverUrl: Array.isArray(candidate.image) ? candidate.image[0] : (candidate.image?.url || candidate.image || ""),
        durationSeconds: parseDuration(candidate.duration),
        description: candidate.description || ""
      };
    }
  }
  return null;
}

export function parseXiaoyuzhouHtml(html = "") {
  const nextMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    const data = JSON.parse(nextMatch[1]);
    const episode = data?.props?.pageProps?.episode;
    if (episode) {
      const mediaKey = episode.mediaKey || "";
      const audioUrl = episode.audio?.contentUrl || episode.audioUrl || (mediaKey ? `https://media.xyzcdn.net/${mediaKey}` : "");
      const coverUrl = episode.podcast?.image?.picUrl || episode.image?.picUrl || "";
      if (!audioUrl) throw new Error("小宇宙页面没有可用的音频地址");
      return {
        showName: episode.podcast?.title || "",
        title: episode.title || "未命名单集",
        audioUrl,
        coverUrl,
        durationSeconds: parseDuration(episode.duration),
        description: episode.description || ""
      };
    }
  }

  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    try {
      const episode = jsonLdEpisode(JSON.parse(match[1]));
      if (episode) return episode;
    } catch {
      // Try the next JSON-LD block.
    }
  }
  throw new Error("无法从小宇宙页面解析单集信息");
}

function directAudioTitle(url) {
  const raw = basename(decodeURIComponent(url.pathname), extname(url.pathname)).replace(/[-_]+/g, " ").trim();
  return raw || "音频节目";
}

export async function resolvePodcastUrl(value, options = {}) {
  if (!isSupportedPodcastUrl(value)) return null;
  if (isDirectAudioUrl(value) && !isXiaoyuzhouEpisodeUrl(value)) {
    const url = await assertSafeRemoteUrl(value, options);
    return {
      platform: "direct_audio",
      showName: url.hostname,
      title: directAudioTitle(url),
      audioUrl: url.toString(),
      coverUrl: "",
      durationSeconds: 0,
      description: ""
    };
  }

  const { response, finalUrl } = await fetchPublicUrl(value, options);
  if (!response.ok) throw new Error(`小宇宙页面请求失败：HTTP ${response.status}`);
  const final = new URL(finalUrl);
  if (!isAllowedXiaoyuzhouHost(final.hostname)) throw new Error("小宇宙链接重定向到了不受信任的域名");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_HTML_BYTES) throw new Error("小宇宙页面体积过大");
  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error("小宇宙页面体积过大");
  const episode = parseXiaoyuzhouHtml(html);
  await assertSafeRemoteUrl(episode.audioUrl, options);
  return { platform: "xiaoyuzhou", ...episode };
}
