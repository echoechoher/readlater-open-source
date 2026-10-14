# Readlater Regression Checklist

Run this short pass before and after changes that touch capture, reading, annotation, AI, or archive behavior.

## Automated

```bash
pnpm test
node --check server.mjs
node --check public/app.js
node --check extension/content-script.js
node --check extension/content-normalization.js
```

Automated coverage includes podcast URL security, Xiaoyuzhou parsing, Tingwu result normalization, task leases and recovery, transcript persistence, API state transitions, duplicate imports, cancellation, retry protection, and long-transcript Digest chunking.

## Content Fidelity

- WeChat prose should not contain repeated visible spaces outside `pre` and `code`.
- Chinese punctuation should not have stray spaces before `，。！？；：、` or inside paired punctuation.
- Source `strong`, `em`, headings, paragraphs, lists, blockquotes, tables, code, and figures should remain semantic blocks.
- A normal prose paragraph should not contain a large sequence of `<br>` elements. Consecutive source paragraphs should render as separate `<p>` elements.
- Images should render as independent figures when they occupy their own source block.
- Existing saved highlights must still attach after display-time whitespace normalization.
- On viewports at or below 760px, opening an article should collapse the Inbox list and show the reader immediately.

## End-to-End

- X: save one status with text and media from the Chrome extension. Inbox should show one item, only the main post body, no replies or unrelated page text.
- WeChat: save one public-account article. The item should appear in Inbox, preserve tables and heading levels, store article images under `/media/`, and keep images in their original reading positions.
- Completeness: submit a deliberately shorter duplicate capture. It must not replace a complete version with fewer tables, images, headings, code blocks, or list items.
- Web: save one normal webpage. Title, body, source icon, original-link button, and reading layout should be usable.
- iOS Share: share one URL through the iOS Shortcut. It should land at the top of Inbox after refresh.
- Highlight: select text in the reader, use highlight-only, and confirm scroll position stays stable and the highlight remains visible.
- Comment: select text, type a comment, press Enter, then edit and delete it from the comment menu.
- AI: run L1, run L2, and send one free-form follow-up. Messages should stay in one article-scoped conversation and render Markdown.
- Archive: archive an item, switch to Archive, restore it, and confirm it returns to Inbox.
- Delete: right-click an Inbox item, confirm the small menu appears, then delete only a disposable test item.

## Podcast Transcription

- Import one Xiaoyuzhou episode. The API should return after metadata parsing without waiting for transcription, and the list should show “等待转写”.
- Import one public MP3 or M4A URL. It should be classified as a podcast episode without downloading the media into the web process.
- Import the same episode twice. It must return the existing article and must not create or submit a second paid transcription job.
- Confirm the Worker transitions the episode through queued → processing → completed and survives a Worker restart while the provider task is running.
- Stop the Worker after it claims a polling task. After the lease expires, another Worker must reclaim it. A submission interrupted before the provider task ID is saved must fail safely instead of silently submitting twice.
- During queued/processing, the reader should show a low-noise status card, the cancel action should work, and Digest controls should be disabled.
- Simulate provider failure and a transient status-query failure. Terminal failures should expose a retry button; transient polling failures should back off without creating another provider task.
- Verify transcription requests enable speaker diarization by default and allow an explicit environment override.
- Verify transcript layout starts a new block on speaker changes, long pauses, sufficiently large provider paragraph boundaries, and maximum paragraph length without splitting inside a sentence.
- Verify completed, unannotated podcast transcripts can be re-run from the reader so an older transcript can gain speaker labels; annotated transcripts must remain protected from reflow.
- Complete a fake-provider job and confirm the timestamped transcript is stored under `data/transcripts/<articleId>/<version>.json`, while article-list responses do not include the segment array.
- Highlight Chinese text in the completed transcript, reload, and reopen the episode. The exact range must remain highlighted and the reader must not jump to the top.
- After a completed transcript has highlights, retrying transcription must be rejected to protect saved anchors.
- Run L1 with transcript highlights and verify only nearby transcript context is sent. Run L2 on a long transcript and verify map-reduce chunking stays within the configured character budget.
- Delete a disposable podcast article and confirm its jobs and transcript directory are removed.
- Test the status card and long transcript at desktop width and at or below 760 px.
- Before a real-provider smoke test, verify Tingwu credentials never appear in browser responses, `data/readlater.json`, Worker logs, or Git status.
- Run `pnpm smoke:tingwu -- <public-audio-url>` to verify the configured account can submit, poll, download, and normalize one real Tingwu result. Use a short disposable audio file to minimize cost.

## Highlight Anchoring And Scroll Stability

Use a copied data directory or a disposable article for these cases. Record the selected quote, its surrounding sentence, the highlight ID, `reader.scrollTop` before and after saving, and whether the result survives reload. Unless a case says otherwise, the accepted scroll delta is at most 2 px.

### Exact selection and persistence

- Select part of a single text node. The yellow range must start and end on the exact selected characters, with no extra punctuation or spaces.
- Select across inline markup such as plain text → link → plain text, and plain text → emphasis/strong → plain text. Every rendered segment must carry the same highlight ID and their combined text must equal the selected text.
- Select Chinese text containing punctuation and mixed Chinese/Latin text. The saved quote must not gain or lose whitespace.
- Select text containing emoji or other surrogate-pair characters. The saved range must restore on the same characters after reload.
- Select across a line break or paragraph boundary. The restored range must have the same visible start/end and must not consume adjacent content.
- Save a highlight-only annotation and a highlight with a comment. Both must remain visible after a full page reload and reopening the article.

### Ambiguity, coexistence, and legacy data

- In a paragraph containing the same sentence twice, select only the second occurrence. Saving and reloading must keep the second occurrence highlighted.
- Save both occurrences of identical text as separate highlights. Both must remain independently addressable after reload.
- Create adjacent highlights, then delete one. The other highlight and the underlying paragraph text must remain unchanged.
- Create partially overlapping highlights. Saving, reloading, editing the notes, and deleting either annotation must not corrupt the article DOM or the other annotation.
- Open an article containing a pre-position-anchor highlight (only `selectedText`, `prefix`, and `suffix`). It must resolve to the occurrence best matching its surrounding context.
- Change display-only whitespace normalization without changing the words. Legacy quote anchoring should still find the intended quote where possible.

### Reader stability

- At roughly 25%, 50%, and 90% through a long article, select text and click “只标注”. Saving must not recreate the reader or jump to the article top.
- Repeat the three positions with a typed comment submitted by Enter. The comment should appear in the side panel while the reader stays at the same position.
- Repeat with the left navigation expanded/collapsed and the annotation panel open/closed.
- Repeat after resizing the viewport. The target range must remain in view; layout-driven movement is acceptable only when caused by the resize itself.
- With images below and above the selection uncached, save while images are still loading. Later image layout changes must not be confused with a save-triggered jump.
- Simulate a slow POST response. The native or fallback active highlight must remain visible until the server accepts the annotation.
- Simulate a failed POST response. The pending quote must remain recoverable and the reader must not jump or silently display a saved highlight.

### Interaction boundaries

- Drag from article prose into a generated translation line, or select only translated text. The annotation UI must not accept that range.
- Select inside headings, list items, blockquotes, table cells, and code blocks. Each supported selection must restore at the exact position.
- After selecting, click into the comment field. The active range must stay visibly highlighted even when the native browser selection disappears.
- Copy after selecting. The clipboard must contain only the selected quote, not the whole paragraph or annotation-panel text.
- On a viewport at or below 760 px, perform selection, save, edit, and delete using touch-compatible controls; the reader must not return to the top.

### Browser acceptance matrix

- Current stable Chrome on macOS: all cases above.
- Chrome with CSS Highlight API disabled: active-selection mark fallback, save, reload, edit, and delete.
- Current stable Safari on macOS/iOS: exact selection, fallback appearance, save/reload, and scroll stability.
- Current stable Firefox on macOS: exact selection, fallback appearance, save/reload, and scroll stability.

Automated unit coverage lives in `test/highlight-anchors.test.mjs`; browser acceptance remains necessary for real Selection/Range behavior, layout, focus changes, and scroll preservation.

## Failure And Empty States

- Failed capture should stay low-noise: the list shows only a small failed icon, and the reader shows a short notice plus retry.
- Retry should not create a duplicate item. It should update the current article state.
- Empty Inbox should say only that Inbox is empty.
- Empty Archive should say only that there is no archived content.
