/**
 * Newest-first paging for /resume.
 *
 * File mtime is the cheap proxy so we can slice before reading JSONL.
 * A page then re-sorts by the summary's modified time, which can differ
 * slightly from mtime.
 */
export const SESSION_LIST_PAGE_SIZE = 12;

/**
 * @param {Array<{ filePath: string, mtimeMs: number } | null>} stamped
 * @returns {string[]}
 */
export function pathsNewestFirst(stamped) {
  return stamped
    .filter((entry) => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.filePath);
}

/**
 * @template T
 * @param {T[]} items newest-first
 * @param {number} offset
 * @param {number} limit
 */
export function sliceNewestPage(items, offset = 0, limit = SESSION_LIST_PAGE_SIZE) {
  const start = Math.max(0, offset);
  const page = items.slice(start, start + Math.max(0, limit));
  return {
    page,
    total: items.length,
    offset: start,
    hasMore: start + page.length < items.length,
  };
}
