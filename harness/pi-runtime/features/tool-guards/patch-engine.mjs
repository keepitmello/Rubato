// Senpi-origin apply/recovery semantics, narrowed to the non-UI execution core.
// MIT attribution and license: ./THIRD_PARTY_NOTICES.md

import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizePatchText, parsePatch, replaceChunks } from "./patch-format.mjs";

const mutationTails = new Map();

function abortError(signal) {
  if (!signal?.aborted) return undefined;
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(typeof signal.reason === "string" ? signal.reason : "Operation aborted", "AbortError");
}

function throwIfAborted(signal) {
  const error = abortError(signal);
  if (error) throw error;
}

function isAbort(error, signal) {
  return signal?.aborted === true || error?.name === "AbortError";
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
}

async function withMutationQueue(filePath, operation) {
  const predecessor = mutationTails.get(filePath) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  mutationTails.set(filePath, current);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(filePath) === current) mutationTails.delete(filePath);
  }
}

async function withMutationQueues(filePaths, operation) {
  const sorted = [...new Set(filePaths)].sort((left, right) => left.localeCompare(right));
  const run = (index) => index === sorted.length
    ? operation()
    : withMutationQueue(sorted[index], () => run(index + 1));
  return run(0);
}

async function writeAtomic(filePath, content, signal) {
  const tempPath = `${filePath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  try {
    throwIfAborted(signal);
    await writeFile(tempPath, content);
    throwIfAborted(signal);
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await unlink(filePath);
      // The old destination is already gone. Finish the same logical commit even
      // when cancellation lands here; stopping would expose a missing target.
      await rename(tempPath, filePath);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function resolvePatchPath(cwd, filePath) {
  // This deliberately matches current Senpi. The prompt requires relative paths,
  // while the executor resolves with node:path rather than inventing a new sandbox.
  return path.resolve(cwd, filePath);
}

function isBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0);
}

async function readSnapshot(filePath, signal) {
  throwIfAborted(signal);
  try {
    const bytes = await readFile(filePath);
    throwIfAborted(signal);
    return { exists: true, bytes, binary: isBinary(bytes), content: bytes.toString("utf8") };
  } catch (error) {
    throwIfAborted(signal);
    if (error?.code === "ENOENT") return { exists: false, binary: false, content: "" };
    throw error;
  }
}

async function applyOperation(cwd, hunk, signal) {
  const sourcePath = resolvePatchPath(cwd, hunk.filePath);
  const destinationPath = hunk.type === "update" && hunk.movePath
    ? resolvePatchPath(cwd, hunk.movePath)
    : undefined;
  return withMutationQueues(destinationPath ? [sourcePath, destinationPath] : [sourcePath], async () => {
    throwIfAborted(signal);
    if (hunk.type === "add") {
      await mkdir(path.dirname(sourcePath), { recursive: true });
      throwIfAborted(signal);
      await writeAtomic(sourcePath, hunk.content, signal);
      return { summary: `add: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0 };
    }
    if (hunk.type === "delete") {
      await rm(sourcePath);
      return { summary: `delete: ${hunk.filePath}`, appliedFile: hunk.filePath, fuzz: 0 };
    }

    const source = await readSnapshot(sourcePath, signal);
    if (!source.exists) {
      const error = new Error(`ENOENT: no such file or directory, open '${sourcePath}'`);
      error.code = "ENOENT";
      throw error;
    }
    if (source.binary) {
      if (hunk.chunks.length > 0) throw new Error(`apply_patch cannot apply text hunks to binary file: ${hunk.filePath}`);
      if (!hunk.movePath || !destinationPath) {
        throw new Error(`apply_patch cannot update binary file without a move destination: ${hunk.filePath}`);
      }
      await mkdir(path.dirname(destinationPath), { recursive: true });
      throwIfAborted(signal);
      await writeAtomic(destinationPath, source.bytes, signal);
      // Once the destination is committed, completing source removal is part of
      // the same move. Cancellation is observed only after this operation is
      // recorded by applyPatchDetailed().
      if (destinationPath !== sourcePath) await rm(sourcePath);
      return { summary: `move: ${hunk.filePath} -> ${hunk.movePath}`, appliedFile: hunk.movePath, fuzz: 0 };
    }

    const patched = hunk.chunks.length === 0
      ? { content: source.content, fuzz: 0 }
      : replaceChunks(source.content, hunk.filePath, hunk.chunks);
    const outputPath = destinationPath ?? sourcePath;
    await mkdir(path.dirname(outputPath), { recursive: true });
    throwIfAborted(signal);
    await writeAtomic(outputPath, patched.content, signal);
    if (destinationPath && destinationPath !== sourcePath) await rm(sourcePath);
    return {
      summary: destinationPath ? `move: ${hunk.filePath} -> ${hunk.movePath}` : `update: ${hunk.filePath}`,
      appliedFile: hunk.movePath ?? hunk.filePath,
      fuzz: patched.fuzz,
    };
  });
}

function parseNonEmptyPatch(patchText) {
  const hunks = parsePatch(patchText);
  if (hunks.length > 0) return hunks;
  if (normalizePatchText(patchText).trim() === "*** Begin Patch\n*** End Patch") {
    throw new Error("patch rejected: empty patch");
  }
  throw new Error("apply_patch verification failed: no hunks found");
}

function recoveryInstructions(appliedFiles, failures) {
  const mustReadFiles = [...new Set(failures.filter((failure) => failure.code === undefined)
    .map((failure) => failure.filePath))];
  const mustRead = new Set(mustReadFiles);
  return {
    mustReadFiles,
    mustNotReadFiles: [...new Set(appliedFiles.filter((filePath) => !mustRead.has(filePath)))],
    failedFiles: [...new Set(failures.map((failure) => failure.filePath))],
  };
}

async function notifyProgress(onProgress, progress) {
  try { await onProgress?.(progress); } catch { /* rendering cannot affect mutations */ }
}

function abortedFailure(operationIndex, hunk) {
  return {
    operationIndex,
    filePath: hunk.filePath,
    operation: hunk.type,
    message: "Operation aborted",
    code: "ABORT_ERR",
  };
}

function patchResult(summaries, appliedFiles, failures, fuzz, appliedOperations) {
  return {
    summaries,
    appliedFiles,
    failures,
    hasPartialSuccess: appliedFiles.length > 0 && failures.length > 0,
    recoveryInstructions: recoveryInstructions(appliedFiles, failures),
    details: { fuzz, appliedOperations },
  };
}

export async function applyPatchDetailed(cwd, patchText, { signal, onProgress } = {}) {
  throwIfAborted(signal);
  const hunks = parseNonEmptyPatch(patchText);
  const summaries = [];
  const appliedFiles = [];
  const appliedOperations = [];
  const failures = [];
  let fuzz = 0;
  for (const [operationIndex, hunk] of hunks.entries()) {
    if (signal?.aborted) {
      if (appliedFiles.length === 0) throw abortError(signal);
      failures.push(abortedFailure(operationIndex, hunk));
      break;
    }
    try {
      const applied = await applyOperation(cwd, hunk, signal);
      // No await is allowed between the filesystem commit and these records.
      // This is the operation's observable commit boundary.
      summaries.push(applied.summary);
      appliedFiles.push(applied.appliedFile);
      appliedOperations.push({ operationIndex, filePath: applied.appliedFile, operation: hunk.type, fuzz: applied.fuzz });
      fuzz += applied.fuzz;
    } catch (error) {
      if (isAbort(error, signal)) {
        if (appliedFiles.length === 0) throw abortError(signal) ?? error;
        failures.push(abortedFailure(operationIndex, hunk));
        break;
      }
      failures.push({
        operationIndex,
        filePath: hunk.filePath,
        operation: hunk.type,
        message: error instanceof Error ? error.message : String(error),
        code: errorCode(error),
      });
    }
    await notifyProgress(onProgress, { applied: appliedFiles.length, failed: failures.length, total: hunks.length });
    if (signal?.aborted && operationIndex + 1 < hunks.length) {
      failures.push(abortedFailure(operationIndex + 1, hunks[operationIndex + 1]));
      break;
    }
  }
  return patchResult(summaries, appliedFiles, failures, fuzz, appliedOperations);
}

export function buildPartialFailureText(result) {
  const failureLines = result.failures.map((failure) => `- ${failure.filePath} (${failure.operation}): ${failure.message}`);
  return [
    result.hasPartialSuccess ? "apply_patch partially failed." : "apply_patch failed.",
    "Failed:",
    ...failureLines,
    result.recoveryInstructions.mustReadFiles.length > 0
      ? `Recovery: MUST read ${result.recoveryInstructions.mustReadFiles.join(" and ")} before retrying.`
      : "",
    result.appliedFiles.length > 0
      ? "Earlier file actions in this patch were already applied."
      : "No file actions were applied.",
    result.recoveryInstructions.mustNotReadFiles.length > 0
      ? "Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it."
      : "",
  ].filter(Boolean).join("\n");
}

export function getPendingMutationCount() {
  return mutationTails.size;
}
