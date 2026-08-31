/** Exact one-hit replace. Missing or duplicated needle → throw (loader swallows as drift). */
export function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`tui-chrome transform drift: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}
