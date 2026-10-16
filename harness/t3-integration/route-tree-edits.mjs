// Settings pages Rubato adds (memory, permissions, phone, scheduled) in the route
// tree the TanStack router plugin generates from routes/ at dev and build time.
// The edits reproduce the generator's output byte for byte, so a rebuild leaves
// the file as applied (test/route-tree.test.mjs checks this against the generator).
//
// All pages are registered here in one pass. Six lists (three interfaces, three
// unions) repeat the same settings lines, so each list is anchored on its whole
// settings tail plus the first line after it, which differs between the lists.
// Per-page anchors broke whenever another page had been inserted into that tail.
// The other sections have a unique neighbour line per page.
//
// UPSTREAM_SETTINGS is the pin's own settings routes, in the generator's order;
// update it when a pin bump adds or removes one.
export const UPSTREAM_SETTINGS = [
  'appearance', 'archived', 'connections', 'diagnostics', 'general', 'integrations',
  'keybindings', 'open-source-licenses', 'projects', 'providers', 'scheduled-tasks',
  'snap-shot', 'source-control', 'storage',
];

const pascal = (slug) => `Settings${slug.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`;
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const importLine = (slug) => `import { Route as ${pascal(slug)}RouteImport } from './routes/settings.${slug}'\n`;
const constBlock = (slug) =>
  `const ${pascal(slug)}Route = ${pascal(slug)}RouteImport.update({\n  id: '/${slug}',\n  path: '/${slug}',\n  getParentRoute: () => SettingsRoute,\n} as any)\n`;
const byPathBlock = (slug) =>
  `    '/settings/${slug}': {\n      id: '/settings/${slug}'\n      path: '/${slug}'\n      fullPath: '/settings/${slug}'\n      preLoaderRoute: typeof ${pascal(slug)}RouteImport\n      parentRoute: typeof SettingsRoute\n    }\n`;
const childType = (slug) => `  ${pascal(slug)}Route: typeof ${pascal(slug)}Route\n`;
const childValue = (slug) => `  ${pascal(slug)}Route: ${pascal(slug)}Route,\n`;
const typedLine = (slug) => `  '/settings/${slug}': typeof ${pascal(slug)}Route\n`;
const unionLine = (slug) => `    | '/settings/${slug}'\n`;

// The first line after the settings routes in each repeated list.
const LIST_TAILS = [
  [typedLine, "  '/$environmentId/$threadId': typeof ChatEnvironmentIdThreadIdRoute\n"],
  [typedLine, "  '/': typeof ChatIndexRoute\n"],
  [typedLine, "  '/_chat/': typeof ChatIndexRoute\n"],
  [unionLine, "    | '/$environmentId/$threadId'\n"],
  [unionLine, "    | '/'\n"],
  [unionLine, "    | '/_chat/'\n"],
];

// Unique neighbour lines, keyed by the upstream route a page sits next to.
// Forward-ordered sections take the page before its successor; the reverse-ordered
// ones (imports, route constants, the path map) before its predecessor.
const NEIGHBOURS = [
  [importLine, 'reverse'],
  // Long names wrap after `=`, so the neighbour stops there.
  [(slug) => `const ${pascal(slug)}Route =`, 'reverse'],
  [(slug) => `    '/settings/${slug}': {\n`, 'reverse'],
  [childType, 'forward'],
  [childValue, 'forward'],
];

export function settingsRouteTreeEdits(pages) {
  const all = [...UPSTREAM_SETTINGS, ...pages].toSorted(byName);
  const edits = [];
  // Reverse sections: page goes right after the upstream route that precedes it
  // in reverse order, i.e. before the upstream route that is next smaller.
  const rendered = [importLine, constBlock, byPathBlock, childType, childValue];
  for (const [index, [neighbour, order]] of NEIGHBOURS.entries()) {
    const sequence = order === 'forward' ? all : all.toReversed();
    for (const page of order === 'forward' ? pages.toSorted(byName) : pages.toSorted(byName).toReversed()) {
      const after = sequence.slice(sequence.indexOf(page) + 1).find((slug) => UPSTREAM_SETTINGS.includes(slug));
      edits.push([neighbour(after), rendered[index](page)]);
    }
  }
  const firstPage = pages.toSorted(byName)[0];
  const tailStart = UPSTREAM_SETTINGS.findIndex((slug) => byName(slug, firstPage) > 0);
  const upstreamTail = UPSTREAM_SETTINGS.slice(tailStart);
  const mergedTail = all.filter((slug) => !UPSTREAM_SETTINGS.slice(0, tailStart).includes(slug));
  for (const [line, next] of LIST_TAILS) {
    edits.push([upstreamTail.map(line).join('') + next, mergedTail.map(line).join('') + next, 'replace']);
  }
  return edits;
}
