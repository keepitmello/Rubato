import assert from "node:assert/strict";
import test from "node:test";

import { fakeSession } from "../helpers/context-notes-fake.mjs";
import { ContextNotesController } from "../../src/context-notes/controller.mjs";
import { contextNotesConfig } from "../../src/context-notes/config.mjs";
import { messageText } from "../../src/context-notes/protocol.mjs";
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

test("#given two images in one message that each fit alone #when the pair exceeds the cap #then the later image stays", () => {
  const limit = 4 * MB;
  const message = {
    role: "user",
    timestamp: 1,
    content: [
      { type: "text", text: "two shots" },
      { type: "image", data: payload(3 * MB), mimeType: "image/png" },
      { type: "image", data: payload(3 * MB), mimeType: "image/png" },
    ],
  };

  const [trimmed] = trimRequestImages([message], limit);

  assert.equal(trimmed.content[2].type, "image", "the later image is the one the turn is about");
  assert.match(trimmed.content[1].text, /image omitted/);
  assert.ok(imageBytes([trimmed]) <= limit);
});

test("#given an image the request cannot carry #when the request is prepared #then the placeholder names a history item the tools can read", (t) => {
  const previous = process.env.RUBATO_CONTEXT_MODE;
  process.env.RUBATO_CONTEXT_MODE = "history-notes";
  t.after(() => {
    if (previous === undefined) delete process.env.RUBATO_CONTEXT_MODE;
    else process.env.RUBATO_CONTEXT_MODE = previous;
  });
  const f = fakeSession(t);
  f.ctx.getContextUsage = () => ({ tokens: 100 });
  f.addMessage("user", [
    { type: "text", text: "please look at this screenshot" },
    { type: "image", data: payload(REQUEST_IMAGE_BYTE_LIMIT + 64), mimeType: "image/png" },
  ]);
  const c = new ContextNotesController(f.pi, f.ctx, { requireEngine: false, config: contextNotesConfig({}) });
  t.after(() => c.close());

  const prepared = c.prepareContext({ messages: f.build().messages }, f.ctx).messages;
  const user = prepared.find((message) => messageText(message).includes("please look at this screenshot"));
  const placeholder = user.content.find((block) => typeof block.text === "string" && block.text.startsWith("[image omitted"));
  const ids = placeholder?.text.match(/window_id="([^"]+)" item_id="([^"]+)"/);

  assert.ok(ids, placeholder?.text ?? "placeholder missing");
  const read = c.store.readItem({ window_id: ids[1], item_id: ids[2] });
  assert.match(read.content, /please look at this screenshot/);
  assert.match(read.content, /image mime=image\/png/);
  assert.match(messageText(user), new RegExp(`\\[history: window_id="${ids[1]}" item_id="${ids[2]}"\\]`));
  assert.equal(user.content.some((block) => block.type === "image"), false);
});
