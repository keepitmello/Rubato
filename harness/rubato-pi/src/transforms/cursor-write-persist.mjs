import { replaceOnce } from "./replace-once.mjs";

export function isCursorWriteToolUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/tools/write.js");
}

export function isCursorEditToolUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/tools/edit.js");
}

const WRITE_NEEDLE = `                // Write the file contents.
                await ops.writeFile(absolutePath, content);
                throwIfAborted();
                return {`;

const WRITE_REPLACEMENT = `                // Write the file contents.
                await ops.writeFile(absolutePath, content);
                throwIfAborted();
                if (readBaseline) {
                    const written = await readLocalWriteBaseline(absolutePath);
                    if (written.kind !== "present" || written.content !== content)
                        throw new Error(\`Write did not persist to disk: \${path}\`);
                }
                return {`;

const EDIT_NEEDLE = `                await ops.writeFile(absolutePath, finalContent);
                throwIfAborted();
                const diffResult = generateDiffString(baseContent, newContent);`;

const EDIT_REPLACEMENT = `                await ops.writeFile(absolutePath, finalContent);
                throwIfAborted();
                const persisted = (await ops.readFile(absolutePath)).toString("utf-8");
                if (persisted !== finalContent)
                    throw new Error(\`Edit did not persist to disk: \${path}\`);
                const diffResult = generateDiffString(baseContent, newContent);`;

export function injectCursorWritePersist(source) {
  return replaceOnce(source, WRITE_NEEDLE, WRITE_REPLACEMENT, "write persist verify");
}

export function injectCursorEditPersist(source) {
  return replaceOnce(source, EDIT_NEEDLE, EDIT_REPLACEMENT, "edit persist verify");
}
