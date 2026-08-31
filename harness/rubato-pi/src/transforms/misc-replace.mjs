/**
 * Exact one-shot replace. Missing or duplicated needle is drift.
 * applyTransform swallows the throw while node_modules still has the patch.
 *
 * @param {string} source
 * @param {string} needle
 * @param {string} replacement
 * @param {string} label
 * @returns {string}
 */
export function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`rubato misc vendor transform drift: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}
