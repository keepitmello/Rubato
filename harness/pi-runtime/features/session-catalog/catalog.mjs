import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_SESSION_PAGE_SIZE = 50;
export const MAX_SESSION_PAGE_SIZE = 200;

function integer(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function comparePath(a, b) {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

function includesQuery(info, query) {
  if (!query) return true;
  return [info.name, info.firstMessage, info.allMessagesText, info.cwd, info.id]
    .some((value) => String(value ?? "").toLowerCase().includes(query));
}

async function filesIn(directory) {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(directory, name));
  }
  catch {
    return [];
  }
}

async function candidatePaths(root, includeSubdirectories) {
  if (!includeSubdirectories) return filesIn(root);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(root, entry.name));
    return (await Promise.all(directories.map(filesIn))).flat();
  }
  catch {
    return [];
  }
}

async function discoverCandidates({ root, includeSubdirectories, readHeader, acceptHeader }) {
  const paths = await candidatePaths(root, includeSubdirectories);
  const candidates = await Promise.all(paths.map(async (path) => {
    try {
      const [stats, header] = await Promise.all([
        stat(path),
        Promise.resolve().then(() => readHeader(path)),
      ]);
      if (!header || !acceptHeader(header)) return undefined;
      return { path, mtimeMs: stats.mtimeMs };
    }
    catch {
      return undefined;
    }
  }));
  return candidates
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || comparePath(a, b));
}

async function loadInfos(candidates, buildInfo, onProgress, progressOffset, progressTotal) {
  let next = 0;
  let loaded = 0;
  const results = new Array(candidates.length);
  const worker = async () => {
    while (next < candidates.length) {
      const index = next++;
      try {
        results[index] = await buildInfo(candidates[index].path);
      }
      catch {
        results[index] = undefined;
      }
      loaded += 1;
      onProgress?.(progressOffset + loaded, progressTotal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, candidates.length) }, worker));
  return results.filter(Boolean);
}

/**
 * Discover all candidate headers/stat metadata, then parse only the requested
 * page. A non-empty search deliberately scans candidates because message text
 * is not indexed; callers still receive a bounded result page.
 */
export async function listSessionCatalogPage({
  root,
  includeSubdirectories = false,
  readHeader,
  acceptHeader = () => true,
  buildInfo,
  onProgress,
  page = {},
}) {
  if (typeof readHeader !== "function" || typeof buildInfo !== "function") {
    throw new TypeError("session catalog requires header and info readers");
  }
  const offset = integer(page.offset, 0);
  const limit = Math.min(MAX_SESSION_PAGE_SIZE, Math.max(1, integer(page.limit, DEFAULT_SESSION_PAGE_SIZE)));
  const query = String(page.query ?? "").trim().toLowerCase();
  const candidates = await discoverCandidates({ root, includeSubdirectories, readHeader, acceptHeader });

  if (query) {
    const infos = await loadInfos(candidates, buildInfo, onProgress, 0, candidates.length);
    const matches = infos.filter((info) => includesQuery(info, query));
    const sessions = matches.slice(offset, offset + limit);
    return {
      sessions,
      total: matches.length,
      offset,
      hasMore: offset + sessions.length < matches.length,
    };
  }

  const selected = candidates.slice(offset, offset + limit);
  const sessions = await loadInfos(selected, buildInfo, onProgress, offset, candidates.length);
  return {
    sessions,
    total: candidates.length,
    offset,
    hasMore: offset + selected.length < candidates.length,
  };
}
