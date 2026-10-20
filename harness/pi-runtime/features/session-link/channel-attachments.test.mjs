import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CHANNEL_ATTACHMENTS_MAX, buildSessionMessage, parseDelivery } from "./message.mjs";

const channel = (attachments, extra = {}) => ({ v: 1, messageId: "m1", kind: "channel",
  from: { channel: "telegram", chatId: "777", isUser: true, messageId: 41 }, text: "(photo)", attachments, ...extra });

test("a Telegram photo reaches the model as an image beside the envelope, as Roo's photos do", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "rb-channel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const photo = path.join(dir, "cat.jpg");
  writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const doc = path.join(dir, "report.pdf");
  writeFileSync(doc, "%PDF");
  const details = parseDelivery(channel([
    { kind: "photo", path: photo, mime: "image/jpeg" },
    { kind: "document", path: doc, mime: "application/pdf", name: "report.pdf", size: 4 },
  ]));
  const message = buildSessionMessage(details);
  assert.ok(Array.isArray(message.content), "the message carries parts, not one string");
  const [text, image, ...rest] = message.content;
  assert.equal(text.type, "text");
  assert.match(text.text, /<channel_message via="telegram" chat="777" message="41">/);
  assert.ok(text.text.includes(`[photo (image/jpeg): ${photo}]`), "the photo's path is named too");
  assert.ok(text.text.includes(`[document report.pdf (application/pdf): ${doc}]`), "a file is a path the model can open");
  assert.deepEqual(image, { type: "image", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"), mimeType: "image/jpeg" });
  assert.deepEqual(rest, [], "a document is not inlined");
  assert.deepEqual(message.details.attachments.map((item) => item.kind), ["photo", "document"], "the transcript keeps what arrived");
  assert.equal(message.details.text, "(photo)", "the app shows the words, not the paths");
});

test("a photo that cannot be read stays a path line, and a message without files stays one string", () => {
  const details = parseDelivery(channel([{ kind: "photo", path: "/nowhere/gone.jpg" }]));
  const message = buildSessionMessage(details, { readFile: () => { throw new Error("ENOENT"); } });
  assert.equal(typeof message.content, "string");
  assert.match(message.content, /\[photo: \/nowhere\/gone\.jpg\]/);
  const plain = buildSessionMessage(parseDelivery(channel(undefined, { text: "글" })));
  assert.equal(typeof plain.content, "string");
  assert.equal(plain.details.attachments, undefined);
});

test("attachments are checked: a list, absolute paths, a kind, at most an album's worth", () => {
  assert.throws(() => parseDelivery(channel("x")), /must be a list/);
  assert.throws(() => parseDelivery(channel([{ kind: "photo", path: "relative.jpg" }])), /absolute/);
  assert.throws(() => parseDelivery(channel([{ path: "/a.jpg" }])), /attachment kind/);
  assert.throws(() => parseDelivery(channel(Array.from({ length: CHANNEL_ATTACHMENTS_MAX + 1 }, () => ({ kind: "photo", path: "/a.jpg" })))),
    /at most/);
});
