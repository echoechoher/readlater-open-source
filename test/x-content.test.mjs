import test from "node:test";
import assert from "node:assert/strict";

import {
  isXStatusUrl,
  parseFxTwitterArticle,
  shouldPreferIncomingXContent
} from "../lib/x-content.mjs";

const articleFixture = {
  title: "How we teach AI models",
  cover_media: {
    media_info: {
      __typename: "ApiImage",
      original_img_url: "https://pbs.twimg.com/media/cover.jpg"
    }
  },
  media_entities: [],
  content: {
    blocks: [
      {
        type: "unstyled",
        text: "How do AI models learn new skills and behaviors?",
        entityRanges: [],
        inlineStyleRanges: []
      },
      {
        type: "header-two",
        text: "Helpful colleagues",
        entityRanges: [],
        inlineStyleRanges: []
      },
      {
        type: "unstyled",
        text: "Read the model specification and learn what can improve.",
        entityRanges: [{ key: 0, offset: 9, length: 19 }],
        inlineStyleRanges: [{ style: "Italic", offset: 39, length: 4 }]
      },
      {
        type: "ordered-list-item",
        text: "Read everything about the game.",
        entityRanges: [],
        inlineStyleRanges: []
      },
      {
        type: "ordered-list-item",
        text: "Practice through trial and error.",
        entityRanges: [],
        inlineStyleRanges: []
      },
      {
        type: "atomic",
        text: " ",
        entityRanges: [{ key: 1, offset: 0, length: 1 }],
        inlineStyleRanges: []
      }
    ],
    entityMap: [
      {
        key: "0",
        value: {
          type: "LINK",
          data: { url: "https://model-spec.openai.com/example" }
        }
      },
      {
        key: "1",
        value: {
          type: "DIVIDER",
          data: {}
        }
      }
    ]
  }
};

test("parses FxTwitter Article blocks, formatting, links, and cover media", () => {
  const parsed = parseFxTwitterArticle(articleFixture);

  assert.equal(parsed.title, "How we teach AI models");
  assert.match(parsed.contentText, /^How do AI models learn/);
  assert.match(parsed.contentMarkdown, /^!\[How we teach AI models\]\(https:\/\/pbs\.twimg\.com\/media\/cover\.jpg\)/);
  assert.match(parsed.contentMarkdown, /## Helpful colleagues/);
  assert.match(
    parsed.contentMarkdown,
    /\[model specification\]\(https:\/\/model-spec\.openai\.com\/example\)/
  );
  assert.match(parsed.contentMarkdown, /\*what\*/);
  assert.match(parsed.contentMarkdown, /1\. Read everything/);
  assert.match(parsed.contentMarkdown, /2\. Practice through trial and error/);
  assert.match(parsed.contentMarkdown, /---$/);
  assert.deepEqual(parsed.media, [{
    type: "image",
    url: "https://pbs.twimg.com/media/cover.jpg",
    alt: "How we teach AI models",
    caption: "",
    poster: ""
  }]);
});

test("recognizes X status URLs", () => {
  assert.equal(isXStatusUrl("https://x.com/leerob/status/2080467752897146898?s=12"), true);
  assert.equal(isXStatusUrl("https://twitter.com/leerob/statuses/2080467752897146898"), true);
  assert.equal(isXStatusUrl("https://x.com/home"), false);
});

test("keeps the more complete X content during duplicate capture or refetch", () => {
  const short = {
    url: "https://x.com/leerob/status/2080467752897146898",
    contentText: "A short teaser.",
    contentMarkdown: "A short teaser."
  };
  const long = {
    url: short.url,
    contentText: "Full article ".repeat(100),
    contentMarkdown: "# Full article\n\n" + "Full article ".repeat(100)
  };

  assert.equal(shouldPreferIncomingXContent(short, long), true);
  assert.equal(shouldPreferIncomingXContent(long, short), false);
  assert.equal(
    shouldPreferIncomingXContent(
      { url: "https://example.com", contentText: "Long existing content" },
      { url: "https://example.com", contentText: "Updated" }
    ),
    true
  );
});
