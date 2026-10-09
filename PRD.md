# Readlater PRD v0.1

## 1. 产品定位

Readlater 是一个个人使用的网络内容剪藏、阅读、标注和消化工具。

它解决的问题不是“收藏更多内容”，而是把 Echo 在网页和移动端看到的好内容，稳定收进一个个人阅读工作台，并最终通过 digest 流程沉淀到 Notion。

一句话：

> 一个本地优先的个人内容收件箱和阅读加工台：桌面网页用 Chrome 插件收，移动端内容用 iOS 快捷指令收，在本地阅读、划线、写想法，再用 digest L1/L2 消化并写入 Notion。

## 2. 背景与问题

Echo 的阅读来源分散在：

- 普通网页文章
- X / Twitter
- 微信公众号文章
- 手机端刷到的链接或内容
- 其他临时转发位置，例如微信文件传输助手

现有问题：

- 看到内容和真正读完之间断裂
- 收藏入口太散，移动端和桌面端不统一
- 阅读时产生的高亮和想法没有顺畅进入 Notion
- digest skill 已经有认知沉淀流程，但依赖 Readwise，而 Readwise 成本高
- 微信文件传输助手适合临时转发，但不适合作为稳定自动化底层

## 3. 产品目标

v0.1 的目标：

1. 桌面端可以一键保存当前网页到 Readlater
2. 移动端可以通过 iOS 快捷指令把链接发送到 Readlater
3. Readlater 提供一个统一 Inbox，承接所有来源
4. 用户可以在本地网页中阅读、划线、高亮、写 note
5. 用户可以触发 digest L1 / L2
6. 消化后的高亮、想法和讨论内容可以写入 Notion

不追求：

- 成为公开产品
- 多用户协作
- 社交分享
- 云端知识库
- 替代 Notion
- 复杂知识图谱

## 4. 核心用户故事

### 4.1 桌面网页剪藏

作为 Echo，我在 Chrome 里看到一篇文章或一条 X thread，希望点击插件后直接保存到 Readlater，之后可以在本地阅读器里慢慢读。

流程：

```text
Chrome 当前页面
-> 点击 Readlater 插件
-> 插件抓取当前页面内容
-> 保存到本地 Inbox
-> 显示保存成功
```

### 4.2 移动端转发

作为 Echo，我经常在手机上看到不错的内容，希望不用付费 Readwise，也不用手动回电脑整理，而是可以通过 iOS 快捷指令转发给 Readlater。

流程：

```text
iPhone 上看到链接
-> 分享
-> 选择 Send to Readlater 快捷指令
-> 快捷指令 POST 到 Readlater 收件接口
-> Readlater 创建 Inbox item
-> 后端抓取正文
```

### 4.3 阅读与标注

作为 Echo，我希望打开 Readlater 后看到所有待读内容，可以阅读正文、划线高亮，并在高亮旁边写自己的想法。

流程：

```text
Inbox
-> 打开文章
-> 阅读
-> 高亮关键段落
-> 为高亮写 note
-> 保存为 Reading / Ready for Digest
```

### 4.4 Digest L1

作为 Echo，我已经读完并标注了一篇文章，希望 AI 基于我的高亮和 note 帮我消化，而不是重新泛泛总结全文。

流程：

```text
文章 + 我的高亮 + 我的 note
-> 点击 Digest L1
-> AI 分析我关注的主题、观点和盲区
-> 输出整体判断和核心观点
-> 进入讨论或保存结果
```

### 4.5 Digest L2

作为 Echo，我有时还没仔细读，希望 AI 先帮我看一遍，挑出值得关注的段落，并给出独立判断。

流程：

```text
文章全文
-> 点击 Digest L2
-> AI 选择 5-7 条高价值标注
-> 每条包含原文段落和 AI 的想法
-> Echo 确认、修改或补充
-> 进入讨论和 Notion 沉淀
```

### 4.6 写入 Notion

作为 Echo，我希望被消化过的内容最终进入 Notion 的「已消化」主题页面，而不是停留在 Readlater 里。

流程：

```text
Digest 结果
-> Echo 确认可以沉淀
-> AI/系统按主题分类高亮
-> 写入 Notion 对应主题子页面
-> 标记文章为 Synced
```

## 5. 内容来源范围

### 5.1 v0.1 支持

- 普通网页文章
- 微信公众号网页文章，即 `mp.weixin.qq.com`
- X / Twitter 当前页面已渲染内容
- 移动端通过 iOS 快捷指令发送的 URL
- 手动粘贴 URL

### 5.2 抓取策略

使用三层 extractor：

```text
第一层：通用 Readability 抽取
第二层：站点 adapter
第三层：fallback 当前可见文本 / body text
```

普通网页：

- 优先使用 Readability 抽取正文
- 保存 title、url、site、author、published time、正文

微信公众号：

- 使用专门 adapter
- 抓取标题、公众号名、作者、发布时间、正文
- 仅支持在浏览器中打开的公众号网页
- 不支持直接从微信 App 或微信桌面客户端 WebView 中自动读取

X / Twitter：

- 使用专门 adapter
- 抓取当前页面已渲染的 tweet/thread 文本、作者、时间、媒体链接
- 不保证抓到未展开、未滚动加载、被折叠的内容
- 失败时保存 URL 和当前可见文本

移动端链接：

- iOS 快捷指令发送 URL 到 Readlater 收件接口
- 后端尝试抓取正文
- 如果抓取失败，保留 URL，并标记为 Needs Review

## 6. 移动端入口：iOS 快捷指令

Readlater 不使用 Readwise 作为移动入口。v0.1 使用 iOS Shortcuts。

### 6.1 快捷指令行为

快捷指令名称：

```text
Send to Readlater
```

输入：

- Share Sheet 传入的 URL
- 可选：页面标题
- 可选：用户手动输入的一句话 note

请求：

```http
POST /api/inbox/mobile
Content-Type: application/json
Authorization: Bearer <personal_token>
```

Payload：

```json
{
  "url": "https://example.com/article",
  "title": "optional title",
  "note": "optional quick note",
  "source": "ios_shortcut"
}
```

返回：

```json
{
  "ok": true,
  "itemId": "inbox_item_id",
  "status": "queued"
}
```

### 6.2 网络要求

因为 iPhone 不能访问电脑上的 `localhost`，移动端入口需要以下三种方式之一：

1. 同一 Wi-Fi 下访问 Mac 局域网地址，例如 `http://192.168.x.x:3000`
2. 使用临时隧道地址，例如 ngrok / Cloudflare Tunnel
3. 部署一个极轻量云端 inbox relay

v0.1 推荐：

```text
先支持手动配置 Readlater Base URL
本地开发时用局域网 IP 或隧道地址
后续再考虑云端 relay
```

### 6.3 为什么不监听微信文件传输助手

微信文件传输助手可以作为 Echo 的临时中转，但不作为 v0.1 自动化依赖。

原因：

- 微信个人号没有稳定官方 API 可读取文件传输助手消息
- 非官方监听方案脆弱，且可能有账号风险
- 桌面端自动化会引入太多不可控状态

替代方式：

```text
手机看到内容
-> 直接分享给 Send to Readlater 快捷指令
```

如果用户仍然习惯转发到微信：

```text
手机转发到文件传输助手
-> 回电脑复制链接
-> Readlater 粘贴导入
```

## 7. 产品模块

### 7.1 Chrome 插件

功能：

- 保存当前页面
- 显示抓取状态
- 保存成功后可打开 Readlater

不做：

- 不抓当前选中文本
- 不保存原始 HTML 快照
- 不做复杂弹窗编辑

插件弹窗：

```text
Save page
Open Readlater
Status: saved / failed / already saved
```

### 7.2 Inbox

Inbox 是所有来源的统一入口。

来源包括：

- chrome_extension
- ios_shortcut
- paste_url
- manual

状态：

```text
Queued
Fetching
Ready
Needs Review
Reading
Ready for Digest
Digested
Synced
Archived
```

列表字段：

- title
- source
- site
- created_at
- fetch_status
- reading_status
- digest_status

### 7.3 阅读器

阅读器提供：

- 统一排版正文
- 高亮
- 高亮 note
- 文章级 note
- 原文链接
- 抓取状态提示

阅读器布局：

```text
左侧：Inbox / 状态筛选
中间：正文阅读区
右侧：Notes / Highlights / Digest / Source
```

### 7.4 高亮与想法

高亮数据：

- article_id
- selected_text
- prefix
- suffix
- color
- note
- created_at

定位策略：

- v0.1 使用 text quote selector 思路
- 保存选中文本、前文、后文
- 文章重新渲染时尽量恢复位置

### 7.5 Digest 面板

Digest 面板提供：

- Run L1
- Run L2
- 查看 digest 历史
- 编辑/确认结果
- Send to Notion

L1 输入：

- title
- url
- article text
- Echo highlights
- Echo notes

L1 输出：

- 标注倾向分析
- Echo 关注的主题
- 可能盲区
- 整体判断
- 核心 1-2 个观点
- 可进入讨论的问题或挑战

L2 输入：

- title
- url
- article text

L2 输出：

- 5-7 条建议标注
- 每条包含原文段落
- 每条包含 AI 的独立想法
- 整体判断
- 后续讨论入口

### 7.6 Notion 沉淀

复用 digest skill 的 Notion 结构。

已消化主题：

- agent-product：AI 产品形态、入口与分发、Skill/Agent 架构、任务系统、产品环境模型
- moat-competition：护城河、竞争壁垒、memory 复利、平台 vs 应用层、商业模式
- product-methodology：需求发现方法、dogfooding、scaffolding、PM 角色演化、评测方法
- knowledge-management：知识沉淀、输出习惯、个人知识体系、认知管理

写入规则：

- 每条高亮独立归类到最合适主题
- 同一篇文章的不同高亮可以进入不同主题
- 同一条高亮不重复写入多个主题
- 高亮原文必须原样写入
- Echo note 必须原样写入
- AI 不得改写或缩写高亮和 Echo note

## 8. 数据模型

### 8.1 Article

```text
id
url
canonical_url
title
site_name
author
published_at
content_text
content_html_sanitized
excerpt
source
fetch_status
reading_status
created_at
updated_at
```

### 8.2 InboxItem

```text
id
source
url
title
quick_note
status
article_id
error_message
created_at
updated_at
```

### 8.3 Highlight

```text
id
article_id
selected_text
prefix
suffix
color
note
created_at
updated_at
```

### 8.4 ArticleNote

```text
id
article_id
content
created_at
updated_at
```

### 8.5 DigestRun

```text
id
article_id
level
input_snapshot
output
status
model
created_at
updated_at
```

### 8.6 NotionSync

```text
id
article_id
digest_run_id
target_page_id
status
notion_block_ids
created_at
updated_at
```

## 9. MVP 范围

### 9.1 v0.1 必做

- Chrome 插件保存当前页面
- Readlater 本地 Web App
- URL 粘贴导入
- iOS 快捷指令收件接口
- Inbox 列表
- 文章阅读器
- 高亮
- 高亮 note
- 文章级 note
- Digest L1
- Digest L2
- Notion 写入
- 抓取失败状态

### 9.2 v0.1 不做

- Readwise 集成
- 自动监听微信文件传输助手
- 移动端 App
- 多用户
- 云同步
- 全文搜索
- 标签体系
- PDF
- 视频字幕抓取
- 自动归档
- 浏览器历史批量导入
- 原始 HTML 快照
- 选中文本剪藏

### 9.3 v0.2 可做

- 全文搜索
- 标签
- iOS 快捷指令安装说明页
- Cloudflare Tunnel / relay 配置向导
- X thread 更完整抓取
- 微信公众号图片保留
- Notion sync retry
- Digest 讨论记录编辑器

## 10. 关键页面

### 10.1 Inbox 页面

目的：

- 快速看到所有待处理内容
- 识别哪些抓取失败
- 进入阅读

核心元素：

- 状态筛选
- 来源筛选
- 文章列表
- 粘贴 URL 输入框
- 抓取失败提示

### 10.2 阅读页面

目的：

- 完成阅读、划线、写想法

核心元素：

- 正文
- 高亮交互
- 右侧 note 面板
- Source 信息
- Digest 入口

### 10.3 Digest 页面 / 面板

目的：

- 运行 L1/L2
- 查看 AI 输出
- 确认是否写入 Notion

核心元素：

- Run L1
- Run L2
- Digest result
- Edit discussion
- Send to Notion

### 10.4 Settings 页面

目的：

- 配置个人服务

核心配置：

- Readlater Base URL
- Mobile inbox token
- Model provider / API key
- Notion token
- Notion page IDs
- Chrome extension status

## 11. 技术实现建议

v0.1 推荐本地优先：

```text
Chrome Extension
-> Local Web App
-> Local API Server
-> SQLite
-> Model API
-> Notion API
```

建议栈：

- Frontend：React / Next.js
- Backend：Node.js
- Database：SQLite
- Extractor：Readability + site adapters
- Extension：Chrome Manifest V3
- Mobile：iOS Shortcuts
- Notion：Notion API

核心接口：

```text
POST /api/clip/current-page
POST /api/inbox/url
POST /api/inbox/mobile
GET  /api/articles
GET  /api/articles/:id
POST /api/articles/:id/highlights
POST /api/articles/:id/notes
POST /api/articles/:id/digest
POST /api/articles/:id/notion-sync
```

## 12. 成功标准

v0.1 成功标准：

- Echo 在 Chrome 里看到普通网页，可以一键保存并阅读
- Echo 在手机里看到链接，可以通过 iOS 快捷指令发送到 Readlater
- 微信公众号文章在浏览器中打开后可以保存正文
- X 页面至少可以保存当前已渲染内容
- Echo 可以在 Readlater 里高亮和写 note
- L1 能基于 Echo 的高亮和 note 输出消化结果
- L2 能先读全文并给出 5-7 条建议标注
- 消化后的内容能写入 Notion 对应主题页

## 13. 产品原则

1. Inbox first：所有来源先进入统一 Inbox
2. Local first：个人阅读和标注数据优先保存在本地
3. Notion as source of truth：最终消化后的认知沉淀到 Notion
4. Highlight fidelity：高亮原文和 Echo note 不得被 AI 改写
5. Low ceremony：保存内容必须足够轻，不要让剪藏变成任务
6. Fail gracefully：抓不到全文时，也要保存 URL 和可见文本
7. Digest after reading：L1 优先尊重 Echo 的阅读痕迹，L2 才让 AI 先读先标
