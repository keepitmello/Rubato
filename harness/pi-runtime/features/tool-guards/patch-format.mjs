// Senpi-origin Codex patch parser and fuzzy hunk matching; MIT attribution:
// ./THIRD_PARTY_NOTICES.md

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";

export function normalizePatchText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function stripHeredoc(input) {
  const match = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return match ? (match[2] ?? input) : input;
}

function parseAddHunk(lines, index, endIndex) {
  const filePath = (lines[index] ?? "").slice(ADD_FILE_MARKER.length);
  const contentLines = [];
  let nextIndex = index + 1;
  while (nextIndex < endIndex) {
    const line = lines[nextIndex] ?? "";
    if (line.startsWith("*** ")) break;
    if (!line.startsWith("+")) throw new Error("Invalid patch format: Add File lines must start with '+'");
    contentLines.push(line.slice(1));
    nextIndex += 1;
  }
  return [{
    type: "add",
    filePath,
    content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`,
  }, nextIndex];
}

function collectChangeContexts(lines, index, endIndex) {
  const changeContexts = [];
  let nextIndex = index;
  while (nextIndex < endIndex) {
    const line = lines[nextIndex] ?? "";
    if (line === "@@") {
      nextIndex += 1;
      continue;
    }
    if (line.startsWith("@@ ")) {
      changeContexts.push(line.slice(3));
      nextIndex += 1;
      continue;
    }
    break;
  }
  return [changeContexts, nextIndex];
}

function parseChunkLines(lines, index, endIndex) {
  const oldLines = [];
  const newLines = [];
  let isEndOfFile = false;
  let parsedLines = 0;
  let nextIndex = index;
  while (nextIndex < endIndex) {
    const line = lines[nextIndex] ?? "";
    if (line === EOF_MARKER) {
      if (parsedLines === 0) throw new Error("Update hunk does not contain any lines");
      isEndOfFile = true;
      nextIndex += 1;
      break;
    }
    if (line.startsWith("@@") || line.startsWith("*** ")) break;
    const prefix = line[0];
    const value = line.slice(1);
    if (prefix === undefined) {
      oldLines.push("");
      newLines.push("");
    } else if (prefix === " ") {
      oldLines.push(value);
      newLines.push(value);
    } else if (prefix === "-") {
      oldLines.push(value);
    } else if (prefix === "+") {
      newLines.push(value);
    } else if (parsedLines > 0) {
      break;
    } else {
      throw new Error(`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);
    }
    parsedLines += 1;
    nextIndex += 1;
  }
  if (parsedLines === 0) throw new Error("Update hunk does not contain any lines");
  return [{ oldLines, newLines, isEndOfFile }, nextIndex];
}

function parseUpdateHunk(lines, index, endIndex) {
  const filePath = (lines[index] ?? "").slice(UPDATE_FILE_MARKER.length);
  let nextIndex = index + 1;
  let movePath;
  if ((lines[nextIndex] ?? "").startsWith(MOVE_TO_MARKER)) {
    movePath = (lines[nextIndex] ?? "").slice(MOVE_TO_MARKER.length);
    nextIndex += 1;
  }
  const chunks = [];
  while (nextIndex < endIndex) {
    const line = lines[nextIndex] ?? "";
    if (line.trim() === "") {
      nextIndex += 1;
      continue;
    }
    if (line.startsWith("*** ")) break;
    if (!line.startsWith("@@") && chunks.length > 0) {
      throw new Error(`Expected update hunk to start with a @@ context marker, got: '${line}'`);
    }
    const [changeContexts, afterContexts] = line.startsWith("@@")
      ? collectChangeContexts(lines, nextIndex, endIndex)
      : [[], nextIndex];
    const [chunk, afterChunk] = parseChunkLines(lines, afterContexts, endIndex);
    chunks.push({ changeContexts, ...chunk });
    nextIndex = afterChunk;
  }
  if (chunks.length === 0 && !movePath) throw new Error(`Update file hunk for path '${filePath}' is empty`);
  return [{ type: "update", filePath, movePath, chunks }, nextIndex];
}

export function parsePatch(patchText) {
  const normalized = stripHeredoc(normalizePatchText(patchText).trim()).trim();
  const lines = normalized.split("\n");
  const endIndex = lines.at(-1)?.trim() === END_PATCH_MARKER ? lines.length - 1 : -1;
  if (lines[0]?.trim() !== BEGIN_PATCH_MARKER || endIndex < 0) {
    throw new Error("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
  }
  const hunks = [];
  let index = 1;
  while (index < endIndex) {
    const line = lines[index] ?? "";
    if (!line.startsWith("*** ")) {
      index += 1;
      continue;
    }
    if (line.startsWith(ADD_FILE_MARKER)) {
      const [hunk, next] = parseAddHunk(lines, index, endIndex);
      hunks.push(hunk);
      index = next;
    } else if (line.startsWith(DELETE_FILE_MARKER)) {
      hunks.push({ type: "delete", filePath: line.slice(DELETE_FILE_MARKER.length) });
      index += 1;
    } else if (line.startsWith(UPDATE_FILE_MARKER)) {
      const [hunk, next] = parseUpdateHunk(lines, index, endIndex);
      hunks.push(hunk);
      index = next;
    } else {
      throw new Error(`'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`);
    }
  }
  return hunks;
}

function normalizeSeekLine(line) {
  return line.trim()
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export function seekSequenceWithFuzz(lines, pattern, start, eof) {
  if (pattern.length === 0) return { index: start, fuzz: 0 };
  if (pattern.length > lines.length) return undefined;
  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
  const lastStart = lines.length - pattern.length;
  const match = (index, compare) => pattern.every((expected, offset) => {
    const line = lines[index + offset];
    return line !== undefined && expected !== undefined && compare(line, expected);
  });
  const passes = [
    [(line, expected) => line === expected, 0],
    [(line, expected) => line.trimEnd() === expected.trimEnd(), 1],
    [(line, expected) => line.trim() === expected.trim(), 100],
    [(line, expected) => normalizeSeekLine(line) === normalizeSeekLine(expected), 10_000],
  ];
  for (const [compare, fuzz] of passes) {
    for (let index = searchStart; index <= lastStart; index += 1) {
      if (match(index, compare)) return { index, fuzz };
    }
  }
  return undefined;
}

export function replaceChunks(content, filePath, chunks) {
  const originalLines = normalizePatchText(content).split("\n");
  if (originalLines.at(-1) === "") originalLines.pop();
  const replacements = [];
  let lineIndex = 0;
  let fuzz = 0;
  for (const chunk of chunks) {
    for (const context of chunk.changeContexts) {
      const found = seekSequenceWithFuzz(originalLines, [context], lineIndex, false);
      if (!found) throw new Error(`Failed to find context '${context}' in ${filePath}`);
      fuzz += found.fuzz;
      lineIndex = found.index + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push({ start: originalLines.length, oldLength: 0, newLines: chunk.newLines });
      continue;
    }
    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekSequenceWithFuzz(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    if (!found && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = seekSequenceWithFuzz(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (!found) throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
    fuzz += found.fuzz;
    replacements.push({ start: found.index, oldLength: pattern.length, newLines });
    lineIndex = found.index + pattern.length;
  }
  const nextLines = [...originalLines];
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    nextLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
  }
  nextLines.push("");
  return { content: nextLines.join("\n"), fuzz };
}
