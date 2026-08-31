import { replaceOnce } from "./misc-replace.mjs";

const CRYPTO_NEEDLE = "import { setTimeout as sleep } from \"node:timers/promises\";\n";

const CRYPTO_REPLACEMENT = "import { randomUUID } from \"node:crypto\";\nimport { setTimeout as sleep } from \"node:timers/promises\";\n";

const FS_NEEDLE = "import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from \"fs\";";

const FS_REPLACEMENT = "import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from \"fs\";";

const FN_NEEDLE = "const AUTH_FILE_WRITE_OPTIONS = { encoding: \"utf-8\", mode: 0o600 };\nlet sharedAuthFileReadState;";

const FN_REPLACEMENT = "const AUTH_FILE_WRITE_OPTIONS = { encoding: \"utf-8\", mode: 0o600 };\n/**\n * Replace auth.json without ever leaving a partial file behind.\n *\n * An in-place `writeFileSync` truncates first and then streams bytes: a crash, a\n * full disk, or a killed process in that window leaves a half-written file, and\n * the next read fails to parse credentials that were previously valid. The lock\n * does not help — it serializes writers, not the bytes of one write.\n *\n * So the new contents are written to a unique sibling temp file, forced to disk,\n * and then `rename`d over the target. POSIX rename within one directory is\n * atomic, so a concurrent reader observes either the complete previous JSON or\n * the complete new JSON. The directory is fsynced afterwards so the rename\n * itself survives power loss, not just the file contents.\n *\n * The temp file is created with `O_EXCL` and mode 0600, so the secret is never\n * momentarily world-readable and two writers can never share a temp path.\n */\nfunction atomicWriteAuthFileSync(authPath, contents) {\n    // Same directory as the target: rename is only atomic within a filesystem,\n    // and a temp dir can be on another one.\n    const tempPath = join(dirname(authPath), `.auth.json.${process.pid}.${randomUUID()}.tmp`);\n    let fd;\n    try {\n        // wx = O_CREAT | O_EXCL | O_WRONLY. Fails rather than reusing a path.\n        fd = openSync(tempPath, \"wx\", 0o600);\n        // A single writeSync may write fewer bytes than asked — that is legal, not an\n        // error. Trusting one call silently truncates the credential file, which is the\n        // exact corruption this function exists to prevent. Loop on the returned count.\n        //\n        // Byte offsets, not string indices: a JS string index into UTF-8 output would\n        // resume mid-codepoint on any non-ASCII byte and corrupt the JSON.\n        const payload = Buffer.from(contents, \"utf-8\");\n        let written = 0;\n        while (written < payload.length) {\n            const count = writeSync(fd, payload, written, payload.length - written);\n            if (!(count > 0)) {\n                throw new Error(`auth storage write stalled after ${written} of ${payload.length} bytes`);\n            }\n            written += count;\n        }\n        // Force the bytes out before the rename publishes them. Without this the\n        // rename can land while the contents are still only in the page cache.\n        fsyncSync(fd);\n        closeSync(fd);\n        fd = undefined;\n        // umask cannot loosen an explicit chmod, so assert the mode we promise.\n        chmodSync(tempPath, 0o600);\n        renameSync(tempPath, authPath);\n    }\n    catch (error) {\n        // Never leave the temp file behind, and never mask the original failure.\n        if (fd !== undefined) {\n            try {\n                closeSync(fd);\n            }\n            catch {\n                // Closing failed on an already-failing path; the unlink below still runs.\n            }\n        }\n        try {\n            if (existsSync(tempPath))\n                unlinkSync(tempPath);\n        }\n        catch {\n            // Cleanup is best-effort: the original error is what the caller needs.\n        }\n        throw error;\n    }\n    // Directory fsync makes the rename itself durable across power loss. Without it the\n    // rename can still be lost even though the file contents were fsynced.\n    //\n    // This is not best-effort. Swallowing the error would report success for a write\n    // whose durability was never established. POSIX (including macOS, verified) allows\n    // opening a directory read-only and fsyncing it; only Windows refuses, and only\n    // those errnos are tolerated.\n    try {\n        const dirFd = openSync(dirname(authPath), \"r\");\n        try {\n            fsyncSync(dirFd);\n        }\n        finally {\n            closeSync(dirFd);\n        }\n    }\n    catch (error) {\n        const code = typeof error === \"object\" && error !== null && \"code\" in error\n            ? String(error.code)\n            : undefined;\n        // Windows cannot fsync a directory handle obtained this way. Nothing else is excused.\n        const unsupported = process.platform === \"win32\" && (code === \"EPERM\" || code === \"EISDIR\" || code === \"EACCES\");\n        if (!unsupported) {\n            // The rename already happened, so the target now holds the complete new JSON\n            // and cannot be rolled back. Say exactly that instead of claiming success:\n            // callers must not read this as \"the credential was not written\".\n            const reason = error instanceof Error ? error.message : String(error);\n            const failure = new Error(`auth storage replaced ${authPath} but could not fsync its directory: ${reason}`);\n            failure.cause = error;\n            failure.authFileReplaced = true;\n            throw failure;\n        }\n    }\n}\nlet sharedAuthFileReadState;";

const WRITE_EMPTY_NEEDLE = "            writeFileSync(this.authPath, \"{}\", AUTH_FILE_WRITE_OPTIONS);\n            chmodSync(this.authPath, 0o600);";

const WRITE_EMPTY_REPLACEMENT = "            atomicWriteAuthFileSync(this.authPath, \"{}\");";

const WRITE_SYNC_NEEDLE = "            const { result, next } = fn(current);\n            if (next !== undefined) {\n                writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);\n                chmodSync(this.authPath, 0o600);\n            }";

const WRITE_SYNC_REPLACEMENT = "            const { result, next } = fn(current);\n            if (next !== undefined) {\n                atomicWriteAuthFileSync(this.authPath, next);\n            }";

const WRITE_ASYNC_NEEDLE = "            if (next !== undefined) {\n                writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);\n                chmodSync(this.authPath, 0o600);\n            }\n            throwIfCompromised();";

const WRITE_ASYNC_REPLACEMENT = "            if (next !== undefined) {\n                atomicWriteAuthFileSync(this.authPath, next);\n            }\n            throwIfCompromised();";

export function isAuthStorageUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/auth-storage.js");
}

/**
 * Series #12 + #13: atomic + durable auth.json writes.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectAuthStorage(source) {
  let next = replaceOnce(source, CRYPTO_NEEDLE, CRYPTO_REPLACEMENT, "auth crypto import");
  next = replaceOnce(next, FS_NEEDLE, FS_REPLACEMENT, "auth fs import");
  next = replaceOnce(next, FN_NEEDLE, FN_REPLACEMENT, "atomicWriteAuthFileSync");
  next = replaceOnce(next, WRITE_EMPTY_NEEDLE, WRITE_EMPTY_REPLACEMENT, "ensureFileExists write");
  next = replaceOnce(next, WRITE_SYNC_NEEDLE, WRITE_SYNC_REPLACEMENT, "sync mutate write");
  return replaceOnce(next, WRITE_ASYNC_NEEDLE, WRITE_ASYNC_REPLACEMENT, "async mutate write");
}
