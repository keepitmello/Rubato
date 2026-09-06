import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installToolOutputPreviews } from "../../src/extensions/tool-output.mjs";
import { canPreviewToolOutput, previewToolText, TOOL_OUTPUT_THRESHOLD_BYTES } from "../../src/tool-output-policy.mjs";

const large = `start\n${"diagnostic line\n".repeat(3000)}end\n`;
const result = (toolName = "bash", text = large, extra = {}) => ({
  role: "toolResult", toolName, toolCallId: "call-1", isError: false,
  content: [{ type: "text", text }], ...extra,
});

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "rubato-output-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = new Map();
  installToolOutputPreviews({ on: (name, fn) => handlers.set(name, fn) });
  const sessionFile = join(dir, "session.jsonl");
  return {
    dir, handlers, sessionFile,
    artifacts: join(dir, "session-artifacts", "tool-output"),
    run: (messages) => handlers.get("context")({ messages }, { sessionManager: { getSessionFile: () => sessionFile } }),
  };
}

test("small and boundary-size text is returned unchanged", () => {
  for (const text of ["", "ok", "x".repeat(TOOL_OUTPUT_THRESHOLD_BYTES)]) {
    assert.equal(previewToolText(text, "bash", "/tmp/original"), text);
  }
});

test("shell preview preserves head and tail, gives explicit recovery and is smaller", () => {
  const preview = previewToolText(large, "bash", "/tmp/original.txt");
  assert.match(preview, /Original tool-result text: "\/tmp\/original.txt"/);
  assert.match(preview, /\nstart\n/);
  assert.ok(preview.endsWith("end\n"));
  assert.match(preview, /Upstream truncation/);
  assert.ok(Buffer.byteLength(preview) < 9000);
});

test("search previews retain the first matches instead of unrelated tail matches", () => {
  const preview = previewToolText(large, "grep", "/tmp/original.txt");
  assert.match(preview, /\nstart\n/);
  assert.ok(!preview.endsWith("end\n"));
});

test("multibyte boundaries do not corrupt Korean or emoji", () => {
  const text = "한글🙂".repeat(5000);
  const preview = previewToolText(text, "eval", "/tmp/원문.txt");
  assert.ok(!preview.includes("\uFFFD"));
  assert.ok(Buffer.byteLength(preview) < 9000);
});

test("source reads, unknown tools, assistant messages and failures are exempt", () => {
  for (const message of [
    result("read"), result("unknown"), result("bash", large, { isError: true }),
    result("bash", large, { role: "assistant" }),
  ]) assert.equal(canPreviewToolOutput(message), false);
});

test("model context preview preserves original messages, details, images and raw recovery", async (t) => {
  const h = await harness(t);
  const image = { type: "image", mimeType: "image/png", data: "image-data" };
  const message = result("eval", large, { details: { status: "completed", exitCode: 0 } });
  message.content.push(image);
  const before = structuredClone(message);
  const out = await h.run([message]);
  assert.deepEqual(message, before);
  assert.deepEqual(out.messages[0].details, before.details);
  assert.equal(out.messages[0].isError, false);
  assert.equal(out.messages[0].toolCallId, "call-1");
  assert.equal(out.messages[0].content[1], image);
  const files = await readdir(h.artifacts);
  assert.equal(files.length, 1);
  assert.equal(await readFile(join(h.artifacts, files[0]), "utf8"), large);
  assert.equal((await stat(join(h.artifacts, files[0]))).mode & 0o777, 0o600);
});

test("repeated context and session resume use stable previews and a single artifact", async (t) => {
  const h = await harness(t);
  const message = result();
  const first = await h.run([message]);
  assert.deepEqual(await h.run([message]), first);
  h.handlers.get("session_start")();
  assert.deepEqual(await h.run([message]), first);
  assert.equal((await readdir(h.artifacts)).length, 1);
});

test("explicit reads of an artifact are not shortened again", async (t) => {
  const h = await harness(t);
  assert.equal(await h.run([result("read")]), undefined);
});

test("failures and small output have zero artifact IO", async (t) => {
  const h = await harness(t);
  assert.equal(await h.run([result("bash", "ok"), result("bash", large, { isError: true })]), undefined);
  assert.deepEqual(await readdir(h.dir), []);
});

test("no persistent session path means no preview and no invented storage location", async (t) => {
  const h = await harness(t);
  assert.equal(await h.handlers.get("context")({ messages: [result()] }, {}), undefined);
  assert.equal(await h.handlers.get("context")({ messages: [result()] },
    { sessionManager: { getSessionFile: () => "relative.jsonl" } }), undefined);
});

test("unwritable artifact path preserves full evidence without a dead recovery link", async (t) => {
  const h = await harness(t);
  await writeFile(join(h.dir, "session-artifacts"), "not a directory");
  const message = result();
  assert.equal(await h.run([message]), undefined);
  assert.equal(message.content[0].text, large);
});

test("an existing corrupt artifact is not advertised as the original", async (t) => {
  const h = await harness(t);
  await h.run([result()]);
  const hash = createHash("sha256").update(large).digest("hex");
  await writeFile(join(h.artifacts, `${hash}.txt`), "partial");
  h.handlers.get("session_start")();
  assert.equal(await h.run([result()]), undefined);
});

test("cached pointers recreate an artifact removed during the same session", async (t) => {
  const h = await harness(t);
  const first = await h.run([result()]);
  const [file] = await readdir(h.artifacts);
  await rm(join(h.artifacts, file));
  assert.deepEqual(await h.run([result()]), first);
  assert.equal(await readFile(join(h.artifacts, file), "utf8"), large);
});

test("cached pointers do not advertise an artifact changed during the same session", async (t) => {
  const h = await harness(t);
  await h.run([result()]);
  const [file] = await readdir(h.artifacts);
  await writeFile(join(h.artifacts, file), "changed");
  assert.equal(await h.run([result()]), undefined);
});

test("multiple text blocks and nontext metadata are retained independently", async (t) => {
  const h = await harness(t);
  const message = result();
  message.content.push({ type: "text", text: "exit code: 0" }, { type: "text", text: large + "second" });
  const out = await h.run([message]);
  assert.equal(out.messages[0].content.length, 3);
  assert.equal(out.messages[0].content[1].text, "exit code: 0");
  assert.equal((await readdir(h.artifacts)).length, 2);
});
