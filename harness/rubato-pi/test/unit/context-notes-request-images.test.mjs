import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUEST_IMAGE_BYTE_LIMIT,
  base64ByteLength,
  trimRequestImages,
} from "../../src/context-notes/request-images.mjs";

/** A payload of exactly `bytes` decoded bytes, without building a real image. */
const payload = (bytes) => Buffer.alloc(bytes, 7).toString("base64");

const toolResult = (id, bytes) => ({
  role: "toolResult",
  __piSessionContextEntryId: id,
  content: [
    { type: "text", text: `Read image file ${id}` },
    { type: "image", data: payload(bytes), mimeType: "image/png" },
  ],
});

const imageBytes = (messages) =>
  messages.reduce((total, message) =>
    total + (message.content ?? []).reduce((sum, block) =>
      sum + (block.type === "image" ? base64ByteLength(block.data) : 0), 0), 0);

const MB = 1024 * 1024;

test("#given a request already inside the cap #when images are trimmed #then nothing is copied or replaced", () => {
  const messages = [toolResult("a", 3 * MB), toolResult("b", 3 * MB)];

  assert.ok(imageBytes(messages) < REQUEST_IMAGE_BYTE_LIMIT, "the fixture must fit the real cap");
  assert.equal(trimRequestImages(messages), messages, "an untouched request is returned as-is");
});

test("#given more image bytes than the cap #when images are trimmed #then the newest survive and the total fits", () => {
  const limit = 8 * MB;
  const messages = [1, 2, 3, 4].map((n) => toolResult(`t${n}`, 3 * MB));

  const trimmed = trimRequestImages(messages, limit);

  assert.ok(imageBytes(trimmed) <= limit, "the request must fit the cap");
  const newest = trimmed.at(-1).content.find((block) => block.type === "image");
  assert.ok(newest, "the newest image is the one the turn is about, so it stays");
  assert.equal(trimmed[0].content.some((block) => block.type === "image"), false, "the oldest image goes first");
});

test("#given an image dropped from the request #when the placeholder is read #then it names the kind, the size and the item", () => {
  const messages = [toolResult("item-1", 4 * MB)];

  const [only] = trimRequestImages(messages, 1 * MB);
  const placeholder = only.content.find((block) => block.type === "text" && block.text.startsWith("[image omitted"));

  assert.ok(placeholder, "the dropped image leaves a text block behind");
  assert.match(placeholder.text, /image\/png 4\.0MB/);
  assert.match(placeholder.text, /item-1/);
});

test("#given a request to trim #when it returns #then the caller's messages are untouched", () => {
  const messages = [toolResult("a", 4 * MB)];
  const before = JSON.stringify(messages);

  trimRequestImages(messages, 1 * MB);

  assert.equal(JSON.stringify(messages), before, "trimming is a copy, never an edit of the input");
});

test("#given the shipped cap #when it is compared with Anthropic's request limit #then it leaves room for the text around the images", () => {
  const ANTHROPIC_REQUEST_CAP = 32 * MB;

  assert.ok(REQUEST_IMAGE_BYTE_LIMIT > 0);
  assert.ok(REQUEST_IMAGE_BYTE_LIMIT < ANTHROPIC_REQUEST_CAP, "the image budget must sit under the provider cap");
});
