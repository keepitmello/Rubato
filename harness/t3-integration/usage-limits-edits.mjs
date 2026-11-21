// The Usage page's subscription bars for Rubato's own accounts. T3 reads quota through each
// vendor CLI's login, and Rubato runs on its own credentials instead, so the bars were empty.
// Rubato's accounts join as a usage-limit source of kind "rubato" beside any CLIProxyAPI hub:
// one row per account under that provider's icon, read by `rubato auth usage --json`
// (overlay/apps/server/src/usage/RubatoUsageLimits.ts, harness/scripts/rubato-usage.mjs).
//
// The page shows only long windows (weekly, monthly), and each provider's heading moves it
// up or down or folds it away; the arrangement stays in this browser
// (overlay/apps/web/src/components/usage/rubatoUsageLayout.ts, with its meaning in
// overlay/packages/shared/src/rubatoUsageLayout.ts, which the phone shares).
//
// Each account's bar says, as CodexBar does, how far its spend is off an even pace and when it
// runs out at the speed so far ("12% in deficit · Runs out in 21h 32m"), and T3's even-pace tick
// turns red in deficit and green in reserve (overlay/packages/shared/src/rubatoUsagePace.ts,
// shared with the phone's Usage page in mobile/shell-edits.mjs).
//
// The page's token and cost history reads Rubato's own sessions too. They are Pi session logs
// under ~/.rubato-pi/agent/sessions, which T3's Pi reader never looked at, so usage through
// Rubato (most of the Claude use) was missing. The summary splits that directory into one source
// per model vendor (overlay/apps/server/src/usage/rubatoVendorUsage.ts): Anthropic under Claude,
// OpenAI Codex under Codex, xAI under Grok, Antigravity and Cursor under their own, and a
// Gemini or DeepSeek model reached through another road (Vertex, OpenGateway) under Gemini or
// DeepSeek, two usage kinds Rubato adds. Each model keeps its full name, so DeepSeek's eco and
// ultrafast lanes stay apart. The split happens after the scan cache, which holds one provider per
// file, and before the clients, which take one provider per source.
export const usageLimitsOverlays = [
  'apps/server/src/usage/RubatoUsageLimits.ts',
  'apps/server/src/usage/RubatoUsageLimits.test.ts',
  'apps/web/src/components/usage/rubatoUsageLayout.ts',
  'apps/web/src/components/usage/rubatoUsageLayout.test.ts',
  'packages/shared/src/rubatoUsageLayout.ts',
  'packages/shared/src/rubatoUsagePace.ts',
  'packages/shared/src/rubatoUsagePace.test.ts',
  'apps/web/src/components/usage/rubatoUsagePace.browser.test.tsx',
  'apps/server/src/usage/rubatoVendorUsage.ts',
  'apps/server/src/usage/rubatoVendorUsage.test.ts',
];

const PACE_TICK_OLD = [
  '            className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"',
].join('\n');

const PACE_TICK_NEW = [
  '            className={cn(',
  '              "absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full",',
  '              PACE_TICK[paceForecast(window, now)?.stage ?? "on"],',
  '            )}',
].join('\n');

const PACE_FORECAST_LINE = [
  '// Rubato: the tick\'s colour and the line under a bar, from rubatoUsagePace.ts.',
  'const PACE_TICK: Record<PaceStage, string> = {',
  '  deficit: "bg-destructive",',
  '  reserve: "bg-success",',
  '  on: "bg-foreground",',
  '};',
  '',
  'function PaceForecastLine({',
  '  window,',
  '  now,',
  '  className,',
  '  style,',
  '}: {',
  '  readonly window: LimitPoolMember["window"];',
  '  readonly now: number;',
  '  readonly className?: string;',
  '  readonly style?: CSSProperties;',
  '}) {',
  '  const locale = useLocale();',
  '  const m = useMessages();',
  '  const forecast = paceForecast(window, now);',
  '  if (!forecast) return null;',
  '  return (',
  '    <span',
  '      className={cn("truncate text-2xs text-muted-foreground tabular-nums", className)}',
  '      style={style}',
  '    >',
  '      {paceForecastText(forecast, locale, (ms) => formatDuration(ms, m))}',
  '    </span>',
  '  );',
  '}',
  '',
  '',
].join('\n');

const POOL_SECTION_OLD = [
  'function PoolSection({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {',
  '  const color = barColor(pool.driver);',
  '  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);',
  '  const windows = displayLimitWindows(pool);',
  '  const m = useMessages();',
  '  return (',
  '    <section className="flex flex-col gap-3">',
  '      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">',
  '        <ProviderInstanceIcon',
  '          driverKind={pool.driver}',
  '          displayName={label}',
  '          indicatorBackground="var(--background)"',
  '          className="size-5"',
  '          iconClassName="size-4 text-foreground/80"',
  '        />',
  '        {label}',
  '      </h2>',
  '      {windows.map((window) => {',
].join('\n');

const POOL_SECTION_NEW = [
  'function PoolSection({',
  '  pool,',
  '  now,',
  '  collapsed = false,',
  '  onToggle,',
  '  onMove,',
  '  canMoveUp = false,',
  '  canMoveDown = false,',
  '}: {',
  '  readonly pool: LimitPool;',
  '  readonly now: number;',
  '  readonly collapsed?: boolean;',
  '  readonly onToggle?: () => void;',
  '  readonly onMove?: (delta: -1 | 1) => void;',
  '  readonly canMoveUp?: boolean;',
  '  readonly canMoveDown?: boolean;',
  '}) {',
  '  const color = barColor(pool.driver);',
  '  // Rubato rows can name a driver T3 does not ship (a Gemini API key → "gemini").',
  '  const label = providerClients.get(pool.driver)?.label ?? (pool.driver === "gemini" ? "Gemini API" : String(pool.driver));',
  '  const windows = longLimitWindows(pool);',
  '  const m = useMessages();',
  '  return (',
  '    <section className="group/pool flex flex-col gap-3">',
  '      <div className="flex items-center gap-2">',
  '        <button',
  '          type="button"',
  '          onClick={onToggle}',
  '          aria-expanded={!collapsed}',
  '          className="-ms-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm font-medium text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"',
  '        >',
  '          <ChevronRightIcon',
  '            aria-hidden',
  '            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")}',
  '          />',
  '          <ProviderInstanceIcon',
  '            driverKind={pool.driver}',
  '            displayName={label}',
  '            indicatorBackground="var(--background)"',
  '            className="size-5"',
  '            iconClassName="size-4 text-foreground/80"',
  '          />',
  '          <h2 className="truncate">{label}</h2>',
  '          {collapsed ? (',
  '            <span className="truncate text-xs font-normal text-muted-foreground tabular-nums">',
  '              {windows.map((window) => `${window.remainingPercent}%`).join(" · ")} left',
  '            </span>',
  '          ) : null}',
  '        </button>',
  '        <span className="ms-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/pool:opacity-100 focus-within:opacity-100">',
  '          <Button',
  '            variant="ghost-muted"',
  '            size="icon-xs"',
  '            disabled={!canMoveUp}',
  '            onClick={() => onMove?.(-1)}',
  '            aria-label={`Move ${label} up`}',
  '          >',
  '            <ChevronUpIcon aria-hidden />',
  '          </Button>',
  '          <Button',
  '            variant="ghost-muted"',
  '            size="icon-xs"',
  '            disabled={!canMoveDown}',
  '            onClick={() => onMove?.(1)}',
  '            aria-label={`Move ${label} down`}',
  '          >',
  '            <ChevronDownIcon aria-hidden />',
  '          </Button>',
  '        </span>',
  '      </div>',
  '      {(collapsed ? [] : windows).map((window) => {',
].join('\n');

export const usageLimitsEdits = {
  'apps/web/src/components/usage/UsageLimitsPooled.tsx': [
    [
      'import { AlertTriangleIcon, ExternalLinkIcon, TicketIcon } from "lucide-react";',
      'import {\n  AlertTriangleIcon,\n  ChevronDownIcon,\n  ChevronRightIcon,\n  ChevronUpIcon,\n  ExternalLinkIcon,\n  TicketIcon,\n} from "lucide-react";',
      'replace',
    ],
    ['} from "./UsageLimits";\n', '} from "./UsageLimits";\nimport { longLimitWindows, useRubatoUsageLayout } from "./rubatoUsageLayout";\n', 'replace'],
    [
      'import { T, useGT, useMessages } from "gt-react";',
      'import { T, useGT, useLocale, useMessages } from "gt-react";\nimport { paceForecast, paceForecastText, type PaceStage } from "@t3tools/shared/rubatoUsagePace";',
      'replace',
    ],
    [
      '  formatResetsIn,\n  resetCreditChoices,\n} from "@t3tools/shared/usageLimitsCopy";',
      '  formatDuration,\n  formatResetsIn,\n  resetCreditChoices,\n} from "@t3tools/shared/usageLimitsCopy";',
      'replace',
    ],
    [PACE_TICK_OLD, PACE_TICK_NEW, 'replace'],
    [
      '      <LegendRow payload={payload} color={color} now={now} index={index} />',
      [
        '      <LegendRow payload={payload} color={color} now={now} index={index} />',
        '      <PaceForecastLine',
        '        window={window}',
        '        now={now}',
        '        className="hidden px-0.5 @2xl/pool:block"',
        '        style={{ gridColumn: index, gridRow: 2 }}',
        '      />',
      ].join('\n'),
      'replace',
    ],
    [
      '<span className="shrink-0 font-semibold text-foreground tabular-nums">{remaining}%</span>',
      '<span className="shrink-0 font-semibold text-foreground tabular-nums">{remaining}%</span>\n      <PaceForecastLine window={window} now={now} className="min-w-0 flex-1" />',
      'replace',
    ],
    ['function LegendRow({', PACE_FORECAST_LINE],
    ['  createContext,\n  Fragment,\n  type ReactNode,\n', '  createContext,\n  type CSSProperties,\n  Fragment,\n  type ReactNode,\n', 'replace'],
    [POOL_SECTION_OLD, POOL_SECTION_NEW, 'replace'],
    [
      '  const pools = collectLimitPools(collectLimitAccounts(presentations), now);',
      [
        '  const layout = useRubatoUsageLayout();',
        '  const pools = layout.arrange(',
        '    collectLimitPools(collectLimitAccounts(presentations), now).filter(',
        '      (pool) => longLimitWindows(pool).length > 0,',
        '    ),',
        '  );',
      ].join('\n'),
      'replace',
    ],
    [
      '        {pools.map((pool) => (\n          <Fragment key={pool.driver}>\n            <PoolSection pool={pool} now={now} />',
      [
        '        {pools.map((pool, index) => (',
        '          <Fragment key={pool.driver}>',
        '            <PoolSection',
        '              pool={pool}',
        '              now={now}',
        '              collapsed={layout.isCollapsed(pool.driver)}',
        '              onToggle={() => layout.toggle(pool.driver)}',
        '              onMove={(delta) =>',
        '                layout.move(',
        '                  pools.map((entry) => entry.driver),',
        '                  pool.driver,',
        '                  delta,',
        '                )',
        '              }',
        '              canMoveUp={index > 0}',
        '              canMoveDown={index < pools.length - 1}',
        '            />',
      ].join('\n'),
      'replace',
    ],
  ],
  'packages/contracts/src/providerUsageLimits.ts': [
    [
      'export const UsageLimitSourceSnapshot = Schema.Struct({\n  id: UsageLimitSourceId,\n  kind: Schema.Literal("cliproxy"),',
      'export const UsageLimitSourceSnapshot = Schema.Struct({\n  id: UsageLimitSourceId,\n  kind: Schema.Literals(["cliproxy", "rubato"]),',
      'replace',
    ],
  ],
  'apps/server/src/usage/UsageLimitSources.ts': [
    ['import { makeCliproxyApi } from "./cliproxyApi.ts";', 'import { readRubatoUsageSource } from "./RubatoUsageLimits.ts";\n'],
    [
      '    yield* publish(keepLastGoodReadings(yield* Ref.get(stateRef), snapshots));\n  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));',
      [
        '    // Rubato\'s own accounts, beside any configured hub (RubatoUsageLimits.ts).',
        '    const rubato = yield* readRubatoUsageSource(settings, yield* Ref.get(stateRef));',
        '    yield* publish(',
        '      keepLastGoodReadings(yield* Ref.get(stateRef), rubato ? [...snapshots, rubato] : snapshots),',
        '    );',
        '  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));',
      ].join('\n'),
      'replace',
    ],
  ],
  'packages/shared/src/usageLimits.ts': [
    ['        sourceLabel: "CLI Proxy",', '        sourceLabel: source.kind === "rubato" ? "Rubato" : "CLI Proxy",', 'replace'],
  ],
  'packages/provider-pi/src/server/usage.ts': [
    ['      { dir: resolvePiSessionsDir(environment, launchHome, path) },',
      '      { dir: resolvePiSessionsDir(environment, launchHome, path) },\n'
      + '      // Rubato: its sessions are Pi logs under its own home (rubatoVendorUsage.ts splits them by vendor).\n'
      + '      { dir: path.join(home, ".rubato-pi", "agent", "sessions") },',
      'replace'],
  ],
  'apps/server/src/usage/UsageService.ts': [
    ['import { canonicalModelFilter, resolveModelAliases, UsageAggregator } from "./usageAggregation.ts";',
      'import { splitRubatoVendorSources } from "./rubatoVendorUsage.ts";\n'],
    ['    const crossFileSessions = sharedSessions(filesByDir.flat());',
      '    // Rubato: a Pi directory reports one source per model vendor (rubatoVendorUsage.ts).\n'
      + '    const rubatoSources = splitRubatoVendorSources(scannedDirs, filesByDir);\n'],
    ['    ] of scannedDirs.entries()) {\n      let scannedFiles = 0;',
      '    ] of rubatoSources.dirs.entries()) {\n      let scannedFiles = 0;', 'replace'],
    ['      for (const file of filesByDir[index] ?? []) {\n        malformedRecords += file.malformedRecords;',
      '      for (const file of rubatoSources.files[index] ?? []) {\n        malformedRecords += file.malformedRecords;', 'replace'],
  ],
  // Gemini and DeepSeek as usage kinds, with their names, colours and marks on the page.
  'packages/contracts/src/usage.ts': [
    ['  "pi",\n  "muse",\n]);\nexport type UsageProviderKind', '  "pi",\n  "muse",\n  "gemini",\n  "deepseek",\n]);\nexport type UsageProviderKind', 'replace'],
  ],
  'apps/web/src/components/usage/usageProviders.ts': [
    ['} satisfies Record<UsageProviderKind, UsageProviderPresentation>;',
      '  gemini: { label: "Gemini", color: "#4796e3", driverKind: ProviderDriverKind.make("gemini") },\n'
      + '  deepseek: { label: "DeepSeek", color: "#4d6bfe", driverKind: ProviderDriverKind.make("deepseek") },\n'
      + '} satisfies Record<UsageProviderKind, UsageProviderPresentation>;',
      'replace'],
  ],
  'packages/shared/package.json': [
    ['    "./usageLimitsCopy": {\n',
      '    "./rubatoUsageLayout": {\n      "types": "./src/rubatoUsageLayout.ts",\n      "import": "./src/rubatoUsageLayout.ts"\n    },\n'
      + '    "./rubatoUsagePace": {\n      "types": "./src/rubatoUsagePace.ts",\n      "import": "./src/rubatoUsagePace.ts"\n    },\n'],
  ],
};
