import { fileURLToPath } from "node:url";

const PI_AI = "@earendil-works/pi-ai";
const AGENT = "@earendil-works/pi-coding-agent";
const VERSION = "0.85.1";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[parity-gaps:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[parity-gaps:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchOverflow(source) {
  let next = replaceOnce(
    source,
    "    /token limit exceeded/i, // Generic fallback\n    /^4(?:00|13)\\s*(?:status code)?\\s*\\(no body\\)/i, // Cerebras: 400/413 with no body",
    "    /token limit exceeded/i, // Generic fallback\n    /conversation is too long/i, // ChatGPT / Codex backend\n    /please try a shorter message/i, // ChatGPT / Codex backend\n    /requested context length is too (?:large|long)/i, // ChatGPT / Codex backend\n    /^4(?:00|13)\\s*(?:status code)?\\s*\\(no body\\)/i, // Cerebras: 400/413 with no body",
    "overflow-codex-patterns",
  );
  return replaceOnce(
    next,
    "    // Case 2: Silent overflow (z.ai style) - successful but usage exceeds context\n    if (contextWindow && message.stopReason === \"stop\") {\n        const inputTokens = message.usage.input + message.usage.cacheRead;\n        if (inputTokens > contextWindow) {\n            return true;\n        }\n    }\n",
    "    // Case 2: Silent overflow (z.ai style) — successful but uncached input exceeds context.\n    // Cursor bills cacheRead far above the live prompt; a successful turn already fitted\n    // the window, so cacheRead-only overrun is billing noise, not overflow.\n    if (contextWindow && message.stopReason === \"stop\") {\n        const inputTokens = message.usage.input ?? 0;\n        if (inputTokens > contextWindow) {\n            return true;\n        }\n    }\n",
    "overflow-silent-cacheRead",
  );
}

export function patchGoogleSharedInputGuard(source) {
  return replaceOnce(
    source,
    "            const imageContent = model.input.includes(\"image\")",
    "            const imageContent = model.input?.includes(\"image\")",
    "google-input-guard",
  );
}

export function patchPromptCacheTtl(source) {
  return replaceOnce(
    source,
    "    if (cacheRetention === \"long\" && compat.supportsLongCacheRetention)\n        return { ttl: \"30m\" };\n    return undefined;",
    "    if (cacheRetention === \"long\" && compat.supportsLongCacheRetention)\n        return { ttl: \"30m\" };\n    return { ttl: \"30m\" };",
    "prompt-cache-short-30m",
  );
}

export function patchAuthStorage(source) {
  let next = replaceOnce(
    source,
    "import { setTimeout as sleep } from \"timers/promises\";\n",
    "import { randomUUID } from \"crypto\";\nimport { setTimeout as sleep } from \"timers/promises\";\n",
    "auth-crypto",
  );
  next = replaceOnce(
    next,
    "import { existsSync, mkdirSync, readFileSync, writeFileSync } from \"fs\";",
    "import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync, chmodSync } from \"fs\";",
    "auth-fs",
  );
  next = replaceOnce(
    next,
    "const AUTH_FILE_WRITE_OPTIONS = { encoding: \"utf-8\", mode: 0o600 };\nlet sharedAuthFileReadState;",
    `const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 };
function atomicWriteAuthFileSync(authPath, contents) {
    const tempPath = join(dirname(authPath), \`.auth.json.\${process.pid}.\${randomUUID()}.tmp\`);
    let fd;
    try {
        fd = openSync(tempPath, "wx", 0o600);
        const payload = Buffer.from(contents, "utf-8");
        let written = 0;
        while (written < payload.length) {
            const count = writeSync(fd, payload, written, payload.length - written);
            if (!(count > 0)) {
                throw new Error(\`auth storage write stalled after \${written} of \${payload.length} bytes\`);
            }
            written += count;
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        chmodSync(tempPath, 0o600);
        renameSync(tempPath, authPath);
    }
    catch (error) {
        if (fd !== undefined) {
            try { closeSync(fd); } catch {}
        }
        try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
        throw error;
    }
    try {
        const dirFd = openSync(dirname(authPath), "r");
        try { fsyncSync(dirFd); }
        finally { closeSync(dirFd); }
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
        const unsupported = process.platform === "win32" && (code === "EPERM" || code === "EISDIR" || code === "EACCES");
        if (!unsupported) {
            const reason = error instanceof Error ? error.message : String(error);
            const failure = new Error(\`auth storage replaced \${authPath} but could not fsync its directory: \${reason}\`);
            failure.cause = error;
            failure.authFileReplaced = true;
            throw failure;
        }
    }
}
let sharedAuthFileReadState;`,
    "auth-helper",
  );
  next = replaceOnce(
    next,
    "            writeFileSync(this.authPath, \"{}\", AUTH_FILE_WRITE_OPTIONS);",
    "            atomicWriteAuthFileSync(this.authPath, \"{}\");",
    "auth-empty",
  );
  next = replaceOnce(
    next,
    "            if (next !== undefined) {\n                writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);\n            }\n            return result;",
    "            if (next !== undefined) {\n                atomicWriteAuthFileSync(this.authPath, next);\n            }\n            return result;",
    "auth-sync",
  );
  return replaceOnce(
    next,
    "            if (next !== undefined) {\n                writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);\n            }",
    "            if (next !== undefined) {\n                atomicWriteAuthFileSync(this.authPath, next);\n            }",
    "auth-async",
  );
}

export function patchToolDescriptions(source) {
  let next = replaceOnce(
    source,
    "/** Wrap a ToolDefinition into an AgentTool for the core runtime. */\nexport function wrapToolDefinition",
    "import { slimToolDescription } from \"../../rubato-features/parity-gaps/slim.mjs\";\n\n/** Wrap a ToolDefinition into an AgentTool for the core runtime. */\nexport function wrapToolDefinition",
    "slim-import",
  );
  return replaceOnce(
    next,
    "        description: definition.description,\n",
    "        description: slimToolDescription(definition.name, definition.description),\n",
    "slim-wrap",
  );
}

function patch(id, packageName, path, preimageSha256, apply) {
  return Object.freeze({ id, packageName, version: VERSION, path, preimageSha256, apply });
}

export const patches = Object.freeze([
  patch("overflow", PI_AI, "dist/utils/overflow.js", "5537cdf670ea8592a46a48a61c847f47a72dd9cab8505165b8e3abc9cba978d3", patchOverflow),
  patch("google-input-guard", PI_AI, "dist/api/google-shared.js", "c06c0d8eb5f7727dc8b3cd5b48cd099508bfda668b25e3ca06dde244b11a3be8", patchGoogleSharedInputGuard),
  patch("prompt-cache-ttl", PI_AI, "dist/api/openai-responses.js", "87085aa3c3c865fb51774bc13b669599461fd29e497fc6063bd6f5b9b5262d33", patchPromptCacheTtl),
  patch("auth-storage", AGENT, "dist/core/auth-storage.js", "0b45029901579032b19273a1427f63b622df8e1aaf9ea185eb932c0d4898998c", patchAuthStorage),
  patch("tool-descriptions", AGENT, "dist/core/tools/tool-definition-wrapper.js", "b08ccb77cf3664c3b42e5cee858e150925c0eedbaca397474c3af3de22030abd", patchToolDescriptions),
]);

export const files = Object.freeze([
  Object.freeze({
    packageName: AGENT,
    version: VERSION,
    path: "dist/rubato-features/parity-gaps/slim.mjs",
    sourcePath: fileURLToPath(new URL("./slim.mjs", import.meta.url)),
  }),
]);
