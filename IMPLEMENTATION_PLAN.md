# Readlater Implementation Plan

## 1. Implementation Goal

Build Readlater v0.1 as a local-first personal reading workflow:

```text
Save content
-> Inbox
-> Read and annotate
-> Digest L1/L2
-> Sync to Notion
```

The first runnable version should prove the core loop before adding every input surface. The recommended build order is:

1. Local web app and database
2. Paste URL import and article extraction
3. Inbox and reader
4. Highlight and note
5. Digest L1/L2
6. Notion sync
7. Chrome extension
8. iOS Shortcut mobile inbox

## 2. Recommended Stack

Use a single TypeScript app first:

```text
Next.js
SQLite
Prisma or Drizzle
Mozilla Readability
Chrome Extension Manifest V3
Notion API
Model provider adapter
```

Suggested default:

- Framework: Next.js App Router
- Runtime: Node.js
- Database: SQLite
- ORM: Drizzle or Prisma
- Styling: Tailwind CSS
- Article extraction: `@mozilla/readability` + `jsdom`
- HTML sanitization: `sanitize-html`
- Extension: Manifest V3

Keep the codebase monorepo-style but simple:

```text
readlater/
  apps/
    web/
    extension/
  packages/
    core/
    extractors/
    digest/
    notion/
  data/
    readlater.sqlite
  docs/
```

If speed matters more than package boundaries, start with a flatter layout:

```text
readlater/
  app/
  components/
  lib/
    db/
    extractors/
    digest/
    notion/
  extension/
  data/
  docs/
```

Recommendation for v0.1: use the flatter layout.

## 3. Product Surfaces

### 3.1 Web App

The web app is the main workspace.

Pages:

- `/` redirects to `/inbox`
- `/inbox` shows all saved items
- `/articles/[id]` shows reader, highlights, notes, digest panel
- `/settings` stores local configuration

### 3.2 Chrome Extension

The extension is only an input surface.

Popup actions:

- Save Page
- Open Readlater
- Retry if failed

The extension should not contain product logic. It captures page data and sends it to the local web API.

### 3.3 iOS Shortcut

The shortcut is a mobile input surface.

It sends:

- URL
- optional title
- optional quick note
- source = `ios_shortcut`

The shortcut does not extract content itself. The server receives the URL and runs extraction.

## 4. Core Data Model

### 4.1 `articles`

```sql
id TEXT PRIMARY KEY
url TEXT NOT NULL
canonical_url TEXT
title TEXT
site_name TEXT
author TEXT
published_at TEXT
excerpt TEXT
content_text TEXT
content_html_sanitized TEXT
source TEXT NOT NULL
fetch_status TEXT NOT NULL
reading_status TEXT NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

`fetch_status`:

```text
queued | fetching | ready | failed | needs_review
```

`reading_status`:

```text
inbox | reading | ready_for_digest | digested | synced | archived
```

### 4.2 `inbox_items`

```sql
id TEXT PRIMARY KEY
source TEXT NOT NULL
url TEXT NOT NULL
title TEXT
quick_note TEXT
status TEXT NOT NULL
article_id TEXT
error_message TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

`source`:

```text
chrome_extension | ios_shortcut | paste_url | manual
```

### 4.3 `highlights`

```sql
id TEXT PRIMARY KEY
article_id TEXT NOT NULL
selected_text TEXT NOT NULL
prefix TEXT
suffix TEXT
color TEXT
note TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### 4.4 `article_notes`

```sql
id TEXT PRIMARY KEY
article_id TEXT NOT NULL
content TEXT NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### 4.5 `digest_runs`

```sql
id TEXT PRIMARY KEY
article_id TEXT NOT NULL
level INTEGER NOT NULL
input_snapshot TEXT NOT NULL
output TEXT
status TEXT NOT NULL
model TEXT
error_message TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

`level`:

```text
1 = Echo-highlight-first digest
2 = AI-first annotation digest
```

### 4.6 `notion_syncs`

```sql
id TEXT PRIMARY KEY
article_id TEXT NOT NULL
digest_run_id TEXT
target_page_id TEXT
status TEXT NOT NULL
notion_block_ids TEXT
error_message TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

## 5. API Design

### 5.1 Inbox

```http
POST /api/inbox/url
```

Used by paste URL import.

```json
{
  "url": "https://example.com/article",
  "source": "paste_url"
}
```

```http
POST /api/inbox/mobile
```

Used by iOS Shortcut.

```json
{
  "url": "https://example.com/article",
  "title": "optional",
  "note": "optional",
  "source": "ios_shortcut"
}
```

```http
GET /api/inbox
```

Returns inbox items with article summary.

### 5.2 Articles

```http
GET /api/articles
GET /api/articles/:id
PATCH /api/articles/:id/status
POST /api/articles/:id/refetch
```

### 5.3 Highlights and Notes

```http
POST /api/articles/:id/highlights
PATCH /api/highlights/:id
DELETE /api/highlights/:id
POST /api/articles/:id/notes
PATCH /api/notes/:id
```

### 5.4 Digest

```http
POST /api/articles/:id/digest
```

Request:

```json
{
  "level": 1
}
```

Response:

```json
{
  "digestRunId": "...",
  "status": "completed",
  "output": "..."
}
```

### 5.5 Notion

```http
POST /api/articles/:id/notion-sync
```

Request:

```json
{
  "digestRunId": "...",
  "mode": "notes"
}
```

## 6. Extractor Design

Extractor interface:

```ts
type ExtractInput = {
  url: string;
  html?: string;
  text?: string;
  source?: string;
};

type ExtractResult = {
  url: string;
  canonicalUrl?: string;
  title?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  excerpt?: string;
  contentText: string;
  contentHtmlSanitized?: string;
  extractionMethod: string;
};
```

Extraction order:

```text
1. WeChat adapter if hostname is mp.weixin.qq.com
2. X adapter if hostname is x.com or twitter.com
3. Generic Readability extractor
4. Fallback body text extractor
```

### 6.1 Generic Web

Server fetches URL, parses HTML with Readability, sanitizes result, stores text and safe HTML.

### 6.2 WeChat Adapter

For browser-opened `mp.weixin.qq.com` pages:

- title
- account name
- author
- publish time when available
- article body

If server fetch fails because of anti-bot or context restrictions, the Chrome extension path should send rendered page text.

### 6.3 X Adapter

For X, treat current rendered content as the reliable source.

First version:

- save URL
- capture visible tweet/thread text from browser DOM
- save author/time if easily available
- mark as `needs_review` if only partial text is captured

Avoid promising complete thread capture in v0.1.

## 7. Digest Design

Do not call Claude Code as the first implementation path. Port the digest skill into prompts and application workflow.

### 7.1 L1 Prompt Contract

Input:

- title
- url
- article text
- Echo highlights
- Echo notes

Output:

- highlight tendency analysis
- Echo's main attention themes
- possible blind spots
- overall judgment
- 1-2 core points
- discussion-ready challenges

### 7.2 L2 Prompt Contract

Input:

- title
- url
- article text

Output:

- 5-7 suggested highlights
- original paragraph for each suggested highlight
- AI thought for each suggested highlight
- overall judgment
- discussion starting points

### 7.3 Digest Guardrails

- Preserve quoted highlight text exactly
- Preserve Echo notes exactly
- Do not force links to Echo's current work
- Prefer fewer, high-signal highlights
- L1 should respect Echo's reading traces
- L2 may annotate before Echo reads

## 8. Notion Sync Design

Use the existing digest skill's Notion organization.

Configuration:

```text
NOTION_TOKEN
NOTION_PAGE_AGENT_PRODUCT
NOTION_PAGE_MOAT_COMPETITION
NOTION_PAGE_PRODUCT_METHODOLOGY
NOTION_PAGE_KNOWLEDGE_MANAGEMENT
```

Do not hard-code tokens or page ids in code.

Sync rules:

- Classify each highlight into one best-fit theme
- Do not duplicate one highlight into multiple pages
- Write original highlight text exactly
- Write Echo note exactly
- Append source link
- Mark article as `synced` after success

## 9. Phase Plan

### Phase 1: Project Skeleton

Build:

- Next.js app
- SQLite setup
- Basic database schema
- `/inbox`
- `/articles/[id]`
- `/settings`

Acceptance:

- App starts locally
- Database file is created
- Empty inbox renders
- Settings page renders

### Phase 2: Paste URL Import

Build:

- `POST /api/inbox/url`
- generic Readability extractor
- inbox item status transitions
- article creation

Acceptance:

- Paste a normal article URL
- Article appears in inbox
- Opening article shows readable title and text
- Failed extraction shows `Needs Review`

### Phase 3: Reader and Annotation

Build:

- reader layout
- text selection highlight
- highlight persistence
- highlight note editing
- article-level note

Acceptance:

- User can highlight text
- Highlight remains after reload
- User can add note to highlight
- Article note saves and reloads

### Phase 4: Digest L1/L2

Build:

- model provider adapter
- prompt builder
- `POST /api/articles/:id/digest`
- digest panel
- digest run history

Acceptance:

- L1 uses article, highlights, and notes
- L2 works with article text alone
- Digest output is saved
- Error state is visible

### Phase 5: Notion Sync

Build:

- Notion adapter
- settings for Notion token and page IDs
- sync button
- sync status and retry

Acceptance:

- Digest output can be written to a configured Notion page
- Original highlights and notes are preserved
- Sync success marks article as `synced`
- Failure shows actionable error

### Phase 6: Chrome Extension

Build:

- Manifest V3 extension
- popup UI
- content script extraction
- send captured page to local API
- open Readlater button

Acceptance:

- User can save current Chrome page
- Ordinary webpage saves with content
- WeChat article page saves with content when opened in Chrome
- X page saves visible rendered text

### Phase 7: iOS Shortcut

Build:

- `POST /api/inbox/mobile`
- personal token auth
- shortcut setup instructions
- mobile inbox status handling

Acceptance:

- iPhone share sheet can send URL to Readlater
- Readlater creates inbox item
- Server attempts extraction
- User can later read the item in the web app

## 10. First Engineering Slice

Start with this slice:

```text
Next.js app
SQLite
Paste URL import
Generic extraction
Inbox
Reader
```

Do not start with:

- Chrome extension
- iOS Shortcut
- Notion sync
- X adapter

Reason:

The core product is only real if an article can enter the system, appear in Inbox, and be read in the reader. Once that works, every other input source is an adapter.

## 11. Open Decisions

1. ORM: Prisma or Drizzle
2. Model provider and API shape
3. Whether app should be pure local or include a tiny mobile relay
4. Whether sanitized HTML is enough or the reader should render plain text paragraphs only
5. Whether Notion sync should be manual only or automatic after digest confirmation

Recommended defaults:

- Use Drizzle if keeping schema lightweight
- Use model adapter so provider can change later
- Keep mobile relay out of v0.1 unless local network access becomes painful
- Render sanitized HTML for readability, but store plain text for digest
- Keep Notion sync manual

## 12. Risks

### X capture is incomplete

Mitigation:

- Capture rendered text only
- Mark partial content as `needs_review`
- Avoid claiming full thread support in v0.1

### WeChat article server fetch may fail

Mitigation:

- Prefer Chrome extension rendered DOM for WeChat
- Keep paste URL extractor as best effort

### iOS cannot reach localhost

Mitigation:

- Support configurable base URL
- Start with same Wi-Fi IP or tunnel
- Consider relay later

### Notion blocks can fail due to size limits

Mitigation:

- Chunk rich text under API limits
- Store sync attempts
- Provide retry

## 13. Done Definition for v0.1

Readlater v0.1 is done when:

- Chrome page can be saved
- iOS Shortcut can submit a URL
- Inbox shows all saved items
- Article reader supports highlight and notes
- L1 and L2 digest both work
- Digest result can be manually synced to Notion
- Failed extraction states are understandable
- No Readwise dependency remains
