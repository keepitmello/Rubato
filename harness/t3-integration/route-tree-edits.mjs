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

// What follows the settings children in the two forward lists.
const FORWARD_ENDS = [
  '}\n\nconst SettingsRouteChildren: SettingsRouteChildren = {\n',
  '}\n\nconst SettingsRouteWithChildren = SettingsRoute._addFileChildren(',
];

export function settingsRouteTreeEdits(pages) {
  const all = [...UPSTREAM_SETTINGS, ...pages].toSorted(byName);
  const edits = [];
  // Reverse sections: page goes right after the upstream route that precedes it
  // in reverse order, i.e. before the upstream route that is next smaller.
  const rendered = [importLine, constBlock, byPathBlock, childType, childValue];
  for (const [index, [neighbour, order]] of NEIGHBOURS.entries()) {
    const sequence = order === 'forward' ? all : all.toReversed();
    // The entry each page past the upstream range follows, so the next one can follow it.
    let previous = sequence.findLast((slug) => UPSTREAM_SETTINGS.includes(slug));
    for (const page of order === 'forward' ? pages.toSorted(byName) : pages.toSorted(byName).toReversed()) {
      const after = sequence.slice(sequence.indexOf(page) + 1).find((slug) => UPSTREAM_SETTINGS.includes(slug));
      if (after !== undefined) edits.push([neighbour(after), rendered[index](page)]);
      // Past the last upstream route of a forward list: before the list's closing line.
      else if (order === 'forward') edits.push([FORWARD_ENDS[index - 3], rendered[index](page)]);
      // Past the last upstream route of a reverse list: right after the entry before it.
      else {
        edits.push([rendered[index](previous), rendered[index](previous) + rendered[index](page), 'replace']);
        previous = page;
      }
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

// Top-level pages Rubato adds beside Usage: Memory, Scheduled Tasks and Stats, which the
// rail opens outside Settings (project-rail-edits.mjs, stats-edits.mjs). Upstream has only a few
// top-level routes, so the generator's output is spelled out here; the same test
// checks it. Each list is anchored on its own head, because the three interfaces
// and the three unions otherwise repeat the same lines.
const routeConst = (name, slug) =>
  `const ${name}Route = ${name}RouteImport.update({\n  id: '/${slug}',\n  path: '/${slug}',\n  getParentRoute: () => rootRouteImport,\n} as any)\n`;
const routeByPath = (name, slug) =>
  `    '/${slug}': {\n      id: '/${slug}'\n      path: '/${slug}'\n      fullPath: '/${slug}'\n      preLoaderRoute: typeof ${name}RouteImport\n      parentRoute: typeof rootRouteImport\n    }\n`;

export function topLevelRouteTreeEdits() {
  return [
    ["import { Route as PairRouteImport } from './routes/pair'\n", "import { Route as ScheduledRouteImport } from './routes/scheduled'\n"],
    ["import { Route as ConnectAgentRouteImport } from './routes/connect-agent'\n", "import { Route as MemoryRouteImport } from './routes/memory'\n"],
    ["import { Route as SettingsRouteImport } from './routes/settings'\n", "import { Route as StatsRouteImport } from './routes/stats'\n"],
    ['const PairRoute = PairRouteImport.update({\n', routeConst('Scheduled', 'scheduled')],
    ['const ConnectAgentRoute = ConnectAgentRouteImport.update({\n', routeConst('Memory', 'memory')],
    ['const SettingsRoute = SettingsRouteImport.update({\n', routeConst('Stats', 'stats')],
    [
      "export interface FileRoutesByFullPath {\n  '/': typeof ChatIndexRoute\n  '/connect': typeof ConnectRoute\n  '/connect-agent': typeof ConnectAgentRoute\n  '/pair': typeof PairRoute\n  '/settings': typeof SettingsRouteWithChildren\n",
      "export interface FileRoutesByFullPath {\n  '/': typeof ChatIndexRoute\n  '/connect': typeof ConnectRoute\n  '/connect-agent': typeof ConnectAgentRoute\n  '/memory': typeof MemoryRoute\n  '/pair': typeof PairRoute\n  '/scheduled': typeof ScheduledRoute\n  '/settings': typeof SettingsRouteWithChildren\n  '/stats': typeof StatsRoute\n",
      'replace',
    ],
    [
      "export interface FileRoutesByTo {\n  '/connect': typeof ConnectRoute\n  '/connect-agent': typeof ConnectAgentRoute\n  '/pair': typeof PairRoute\n  '/settings': typeof SettingsRouteWithChildren\n",
      "export interface FileRoutesByTo {\n  '/connect': typeof ConnectRoute\n  '/connect-agent': typeof ConnectAgentRoute\n  '/memory': typeof MemoryRoute\n  '/pair': typeof PairRoute\n  '/scheduled': typeof ScheduledRoute\n  '/settings': typeof SettingsRouteWithChildren\n  '/stats': typeof StatsRoute\n",
      'replace',
    ],
    [
      "  '/_chat': typeof ChatRouteWithChildren\n  '/connect': typeof ConnectRoute\n  '/connect-agent': typeof ConnectAgentRoute\n  '/pair': typeof PairRoute\n  '/settings': typeof SettingsRouteWithChildren\n",
      "  '/_chat': typeof ChatRouteWithChildren\n  '/connect': typeof ConnectRoute\n  '/connect-agent': typeof ConnectAgentRoute\n  '/memory': typeof MemoryRoute\n  '/pair': typeof PairRoute\n  '/scheduled': typeof ScheduledRoute\n  '/settings': typeof SettingsRouteWithChildren\n  '/stats': typeof StatsRoute\n",
      'replace',
    ],
    [
      "  fullPaths:\n    | '/'\n    | '/connect'\n    | '/connect-agent'\n    | '/pair'\n    | '/settings'\n",
      "  fullPaths:\n    | '/'\n    | '/connect'\n    | '/connect-agent'\n    | '/memory'\n    | '/pair'\n    | '/scheduled'\n    | '/settings'\n    | '/stats'\n",
      'replace',
    ],
    [
      "  to:\n    | '/connect'\n    | '/connect-agent'\n    | '/pair'\n    | '/settings'\n",
      "  to:\n    | '/connect'\n    | '/connect-agent'\n    | '/memory'\n    | '/pair'\n    | '/scheduled'\n    | '/settings'\n    | '/stats'\n",
      'replace',
    ],
    [
      "  id:\n    | '__root__'\n    | '/_chat'\n    | '/connect'\n    | '/connect-agent'\n    | '/pair'\n    | '/settings'\n",
      "  id:\n    | '__root__'\n    | '/_chat'\n    | '/connect'\n    | '/connect-agent'\n    | '/memory'\n    | '/pair'\n    | '/scheduled'\n    | '/settings'\n    | '/stats'\n",
      'replace',
    ],
    [
      '  ConnectAgentRoute: typeof ConnectAgentRoute\n  PairRoute: typeof PairRoute\n  SettingsRoute: typeof SettingsRouteWithChildren\n',
      '  ConnectAgentRoute: typeof ConnectAgentRoute\n  MemoryRoute: typeof MemoryRoute\n  PairRoute: typeof PairRoute\n  ScheduledRoute: typeof ScheduledRoute\n  SettingsRoute: typeof SettingsRouteWithChildren\n  StatsRoute: typeof StatsRoute\n',
      'replace',
    ],
    ["    '/pair': {\n", routeByPath('Scheduled', 'scheduled')],
    ["    '/connect-agent': {\n", routeByPath('Memory', 'memory')],
    ["    '/settings': {\n", routeByPath('Stats', 'stats')],
    [
      '  ConnectAgentRoute: ConnectAgentRoute,\n  PairRoute: PairRoute,\n  SettingsRoute: SettingsRouteWithChildren,\n',
      '  ConnectAgentRoute: ConnectAgentRoute,\n  MemoryRoute: MemoryRoute,\n  PairRoute: PairRoute,\n  ScheduledRoute: ScheduledRoute,\n  SettingsRoute: SettingsRouteWithChildren,\n  StatsRoute: StatsRoute,\n',
      'replace',
    ],
  ];
}
