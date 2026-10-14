export function createDigestInputSnapshot(article = {}) {
  return structuredClone({
    title: article.title || "",
    url: article.url || "",
    siteName: article.siteName || "",
    author: article.author || "",
    contentType: article.contentType || "article",
    transcriptVersion: article.transcription?.transcriptVersion || 0,
    contentText: article.contentText || "",
    contentMarkdown: article.contentMarkdown || "",
    highlights: article.highlights || [],
    aiMessages: article.aiMessages || []
  });
}

export function contentAroundHighlights(snapshot = {}, contextCharacters = 1800) {
  const content = snapshot.contentMarkdown || snapshot.contentText || "";
  const ranges = (snapshot.highlights || [])
    .map((highlight) => ({ start: Number(highlight.textStart), end: Number(highlight.textEnd) }))
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start)
    .map((range) => ({
      start: Math.max(0, range.start - contextCharacters),
      end: Math.min(content.length, range.end + contextCharacters)
    }))
    .sort((left, right) => left.start - right.start);
  if (!ranges.length) return "";
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged.map((range, index) => `【标注上下文 ${index + 1}】\n${content.slice(range.start, range.end)}`).join("\n\n");
}

export function buildDigestMapPrompt(chunk, index, total) {
  return `这是播客文稿的第 ${index + 1}/${total} 部分。请忠实压缩为结构化笔记，保留主要论点、关键事实、例子、分歧和结论。不要添加原文没有的信息，不要输出动作协议。\n\n<transcript_chunk>\n${chunk}\n</transcript_chunk>`;
}

export function digestModeInstruction(mode) {
  return {
    sop_b_ai_marks: "按 SOP B 执行：AI 先读先标注，输出 5-7 条建议标注，并进入讨论。",
    sop_a_echo_marks: "按 SOP A 执行：优先分析 Echo 已写 note/comment 的标注，给出标注倾向分析，然后展开有判断的讨论。",
    discussion: "沿用 SOP C 的讨论姿态。基于当前文章、标注、comment 和已有 AI messages 继续回答。"
  }[mode] || "按 digest instructions 执行当前任务。";
}

function formatHighlights(highlights = []) {
  if (!highlights.length) return "无";
  return highlights.map((highlight, index) => [
    `#${index + 1}`,
    `原文：${highlight.selectedText || ""}`,
    highlight.note ? `Echo comment：${highlight.note}` : "",
    highlight.createdAt ? `时间：${highlight.createdAt}` : ""
  ].filter(Boolean).join("\n")).join("\n\n");
}

export function formatDigestConversation(messages = []) {
  if (!messages.length) return "无";
  return messages.map((message, index) => [
    `<turn index="${index + 1}" role="${message.role === "assistant" ? "ai" : "echo"}">`,
    message.content || "",
    "</turn>"
  ].join("\n")).join("\n\n");
}

export function formatNotionConversation(messages = []) {
  if (!messages.length) return "";
  return messages
    .filter((message) => message?.content?.trim())
    .map((message) => `### ${message.role === "assistant" ? "AI" : "Echo"}\n\n${message.content.trim()}`)
    .join("\n\n");
}

const ACTIONS_START = "<readlater_actions>";
const ACTIONS_END = "</readlater_actions>";

export function buildDigestSystemPrompt(digestInstructions = "") {
  return `你是 Readlater 的 digest assistant。下面是你必须完整遵循的 Digest Skill，它同时定义讨论方式和可执行动作。

--- DIGEST SKILL START ---
${digestInstructions}
--- DIGEST SKILL END ---

每次回复都必须在正文最后另起一行输出动作块：
${ACTIONS_START}{"actions":[]}${ACTIONS_END}

当你根据 Digest Skill 判断应把本轮内容写入 Notion 时，动作块必须是：
${ACTIONS_START}{"actions":[{"type":"sync_notion"}]}${ACTIONS_END}

原文保护规则：文章正文只作为阅读和讨论上下文；写入 Notion 的标注原文及其 Echo comment 由 Readlater runtime 从已保存数据中直接读取。你只负责生成讨论、洞察和建议，并判断是否触发同步；不要为同步目的重写、补全或伪造原文，也不要在动作块中携带原文。

动作块是给 Readlater runtime 的控制信息，不要在正文中解释协议，也不要让 Echo 点击按钮或手动复制。除动作块外，只输出本次 AI 回复正文；不要模拟 Echo 的下一轮发言，不要输出 user、assistant、Echo、AI 等角色标签。`;
}

export function buildNotionRoutingSystemPrompt() {
  return `你是 Readlater 的 Notion 路由与认知条目整理器。只返回符合 user 指定结构的合法 JSON，不要使用 Markdown 代码块，不要添加 JSON 之外的文字。

你可以根据 Echo 与 AI 的讨论生成认知条目的标题和讨论内容，但不能生成、改写或补全标注原文及 Echo comment。标注原文和 comment 只能通过索引选择，Readlater runtime 会从已保存数据中原样写入。`;
}

export function parseDigestResponse(value = "") {
  const raw = String(value || "").trim();
  const start = raw.lastIndexOf(ACTIONS_START);
  const end = start >= 0 ? raw.indexOf(ACTIONS_END, start + ACTIONS_START.length) : -1;
  if (start < 0 || end < 0) return { content: raw, actions: [] };

  const content = `${raw.slice(0, start)}${raw.slice(end + ACTIONS_END.length)}`.trim();
  try {
    const payload = JSON.parse(raw.slice(start + ACTIONS_START.length, end).trim());
    const actions = Array.isArray(payload?.actions)
      ? payload.actions.filter((action) => action?.type === "sync_notion")
      : [];
    return { content, actions };
  } catch {
    return { content, actions: [] };
  }
}

export function buildDigestPrompt(job) {
  const snapshot = job.inputSnapshot || {};
  return `当前任务模式：
${job.mode}

模式说明：
${digestModeInstruction(job.mode)}

当前文章：
标题：${snapshot.title || ""}
链接：${snapshot.url || ""}
来源：${snapshot.siteName || ""}
作者：${snapshot.author || ""}

正文：
${snapshot.contentMarkdown || snapshot.contentText || "无"}

Echo 的标注（原文、对应 comment 与时间）：
${formatHighlights(snapshot.highlights)}

已有 AI 讨论：
<conversation_history>
${formatDigestConversation(snapshot.aiMessages)}
</conversation_history>

本次 Echo 指令：
<current_request>
${job.instruction || ""}
</current_request>

输出要求：遵循 system 中的正文与动作块协议。不要模拟、预测或续写 Echo 的下一轮发言；不要输出 user、assistant 等角色标签。`;
}

export function buildNotionRoutingPrompt(job) {
  const snapshot = job.inputSnapshot || {};
  const destinations = job.notionDestinations || [];
  return `你是 Readlater 的知识归档路由器。请只返回一个合法 JSON 对象，不要使用 Markdown 代码块，不要添加解释。

你的任务是：把 Echo 已明确要求沉淀的一次文章消化结果，整理成与现有 Notion 知识库一致的认知条目，并路由到下面已配置的主题页。你只能从这些主题中选择，不能创建新主题或新页面。

可选主题：
${JSON.stringify(destinations.map((item) => ({ key: item.key, name: item.name, description: item.description || "" })), null, 2)}

文章：${snapshot.title || ""}
链接：${snapshot.url || ""}

Echo 高亮：
${formatHighlights(snapshot.highlights)}

本次讨论结果：
${job.sourceDigestContent || ""}

返回格式必须是：
{"routes":[{"destinationKey":"主题 key","title":"认知条目标题","highlightIndexes":[1],"discussion":"基于本次对话整理的讨论内容","reason":"不超过一句"}],"shouldDistill":false,"distillReason":"不超过一句"}

规则：
- 每个 route 对应一个认知条目；同一主题可以有多个不同条目。
- title 是简洁的认知观点标题，不要直接照抄文章标题，不要带 Markdown 标题符号。
- 只有和该条目直接相关的高亮才放入 highlightIndexes；索引从 1 开始。
- discussion 只整理该条目相关的 Echo/AI 讨论，可以使用 Markdown，但不要输出“标注”“我的想法”“讨论”“来源”等模板字段，也不要输出 Echo/AI/user/assistant 角色标签。
- 没有形成讨论时 discussion 返回空字符串；没有可靠路由时 routes 返回空数组。
- 不能改写、概括或伪造高亮内容与 Echo comment；它们由 Readlater 程序按索引从已保存数据中原样写入 Notion。
- shouldDistill 只有在讨论确实产生可复用的新原则、决策或方法时才为 true；当前不会写入 Knowledge Base。`;
}
