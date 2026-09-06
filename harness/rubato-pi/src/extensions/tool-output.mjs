// Only provider-bound context is shortened. Tool execution, eval bridge values,
// UI and saved session messages retain their original content.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { canPreviewToolOutput, previewToolText, TOOL_OUTPUT_THRESHOLD_BYTES } from "../tool-output-policy.mjs";

export function installToolOutputPreviews(pi) {
  // Cache verified file identity, not raw output. Check it before reusing a
  // pointer: external cleanup or edits must not leave a stale recovery link.
  const stored = new Map();
  for (const event of ["session_start", "session_shutdown"]) {
    pi.on(event, () => stored.clear());
  }

  pi.on("context", async (event, ctx) => {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (typeof sessionFile !== "string" || !isAbsolute(sessionFile)) return;
    const dir = join(`${sessionFile.replace(/\.jsonl$/, "")}-artifacts`, "tool-output");
    let changed = false;
    const messages = [];
    for (const message of event.messages) {
      if (!canPreviewToolOutput(message)) {
        messages.push(message);
        continue;
      }
      let messageChanged = false;
      const content = [];
      for (const block of message.content) {
        if (block.type !== "text" || typeof block.text !== "string"
          || Buffer.byteLength(block.text, "utf8") <= TOOL_OUTPUT_THRESHOLD_BYTES) {
          content.push(block);
          continue;
        }
        const hash = createHash("sha256").update(block.text).digest("hex");
        const path = join(dir, `${hash}.txt`);
        try {
          const cached = stored.get(path);
          if (cached) {
            const current = await stat(path).catch(() => undefined);
            if (!current || current.ino !== cached.ino || current.size !== cached.size
              || current.mtimeMs !== cached.mtimeMs || current.ctimeMs !== cached.ctimeMs) stored.delete(path);
          }
          if (!stored.has(path)) {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            try {
              await writeFile(path, block.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
            } catch (error) {
              // A resumed session may already own this content-addressed file.
              // Never point at unrelated or partially written contents.
              if (error?.code !== "EEXIST" || await readFile(path, "utf8") !== block.text) throw error;
            }
            if (stored.size >= 1024) stored.clear();
            stored.set(path, await stat(path));
          }
          content.push({ ...block, text: previewToolText(block.text, message.toolName, path) });
          messageChanged = true;
        } catch {
          // Storage failure must not discard evidence or turn tool success into
          // failure. Leave this block byte-for-byte intact, without a dead link.
          content.push(block);
        }
      }
      messages.push(messageChanged ? { ...message, content } : message);
      changed ||= messageChanged;
    }
    return changed ? { messages } : undefined;
  });
}
