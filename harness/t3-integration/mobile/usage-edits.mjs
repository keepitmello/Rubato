// The phone's Usage page tells, like the desktop's (usage-limits-edits.mjs), how far each
// account's spend is off an even pace and when it runs out at the speed so far, and colours
// T3's even-pace tick red in deficit and green in reserve. The reading and its wording are
// shared with the desktop: packages/shared/src/rubatoUsagePace.ts (overlay).
//
//   legend rows      the forecast line under each account's name
//   wide bars        a forecast row under the bar, since the legend is hidden there
//   account screen   the same line under "Even pace"
//   usage kinds      Gemini and DeepSeek in the history's provider list
//   limits layout    weekly and monthly windows only; each provider's heading folds it and moves
//                    it up or down, kept in the phone's preferences (rubato-shell/usageLayout.ts)

export const mobileUsageOverlays = ['apps/mobile/src/features/rubato-shell/usageLayout.ts'];

const FILE = 'apps/mobile/src/features/usage/UsageLimitsPooled.tsx';

const FORECAST = [
  '// Rubato: the tick\'s colour and the line under a bar, from rubatoUsagePace.ts.',
  'const PACE_TICK: Record<PaceStage, string> = {',
  '  deficit: "absolute top-0.5 bottom-0.5 w-0.5 rounded-full bg-danger-foreground",',
  '  reserve: "absolute top-0.5 bottom-0.5 w-0.5 rounded-full bg-emerald-500",',
  '  on: "absolute top-0.5 bottom-0.5 w-0.5 rounded-full bg-foreground",',
  '};',
  '',
  'function PaceForecastText({',
  '  window,',
  '  now,',
  '  className = "text-xs tabular-nums text-foreground-muted",',
  '}: {',
  '  readonly window: LimitPoolWindow["members"][number]["window"] | null;',
  '  readonly now: number;',
  '  readonly className?: string;',
  '}) {',
  '  const locale = useLocale();',
  '  const m = useMessages();',
  '  const forecast = window ? paceForecast(window, now) : null;',
  '  if (!forecast) return null;',
  '  return (',
  '    <Text numberOfLines={1} className={className}>',
  '      {paceForecastText(forecast, locale, (ms) => formatDuration(ms, m))}',
  '    </Text>',
  '  );',
  '}',
  '',
  '',
].join('\n');

export const mobileUsageEdits = {
  // Gemini and DeepSeek usage kinds (usage-limits-edits.mjs adds them to the contract).
  'apps/mobile/src/features/usage/usageProviders.ts': [
    ['  "pi",\n  "muse",\n];', '  "pi",\n  "muse",\n  "gemini",\n  "deepseek",\n];', 'replace'],
    ['  pi: "Pi",\n  muse: "Muse Code",\n};', '  pi: "Pi",\n  muse: "Muse Code",\n  gemini: "Gemini",\n  deepseek: "DeepSeek",\n};', 'replace'],
  ],
  'apps/mobile/src/features/usage/providerColors.ts': [
    ['    muse: "#0866ff",\n', '    muse: "#0866ff",\n    gemini: "#4796e3",\n    deepseek: "#4d6bfe",\n', 'replace'],
  ],
  // The phone's limits arrangement, kept with its other preferences.
  'apps/mobile/src/persistence/mobile-preferences.ts': [
    ["  readonly collapsedProjectGroups?: readonly string[];\n",
      "  /** Rubato: the Usage page's provider order and folds (rubato-shell/usageLayout.ts). */\n  readonly rubatoUsageLayout?: { readonly order: readonly string[]; readonly collapsed: readonly string[] };\n"],
    ["    collapsedProjectGroups?: readonly string[];\n",
      "    rubatoUsageLayout?: { readonly order: readonly string[]; readonly collapsed: readonly string[] };\n"],
    ["  if (Array.isArray(parsed.collapsedProjectGroups)) {",
      "  if (\n    Array.isArray(parsed.rubatoUsageLayout?.order) &&\n    Array.isArray(parsed.rubatoUsageLayout?.collapsed)\n  ) {\n    const strings = (values: readonly unknown[]) =>\n      values.filter((value): value is string => typeof value === \"string\");\n    preferences.rubatoUsageLayout = {\n      order: strings(parsed.rubatoUsageLayout.order),\n      collapsed: strings(parsed.rubatoUsageLayout.collapsed),\n    };\n  }\n"],
  ],
  [FILE]: [
    ["import { SymbolView } from \"../../components/ui/AppSymbol\";\n",
      "import { longLimitWindows } from \"@t3tools/shared/rubatoUsageLayout\";\nimport { useRubatoUsageLayout } from \"../rubato-shell/usageLayout\";\n"],
    ["  collectLimitPools,\n  displayLimitWindows,\n  paceRemainingPercent,",
      "  collectLimitPools,\n  paceRemainingPercent,", 'replace'],
    ["  const pools = collectLimitPools(collectLimitAccounts(selected), now);",
      "  // Rubato: weekly and monthly windows only, in the order and folds the person left.\n  const layout = useRubatoUsageLayout();\n  const pools = layout.arrange(\n    collectLimitPools(collectLimitAccounts(selected), now).filter(\n      (pool) => longLimitWindows(pool).length > 0,\n    ),\n  );", 'replace'],
    ["      {pools.map((pool) => {\n        const windows = displayLimitWindows(pool);",
      "      {pools.map((pool, index) => {\n        const windows = longLimitWindows(pool);\n        const collapsed = layout.isCollapsed(pool.driver);\n        const label = providerClients.get(pool.driver)?.label ?? pool.driver;", 'replace'],
    ["              <View className=\"flex-row items-center gap-2 px-1\">\n                <ProviderIcon provider={pool.driver} size={18} />\n                <Text className=\"text-base font-t3-medium text-foreground\">\n                  {providerClients.get(pool.driver)?.label ?? pool.driver}\n                </Text>\n              </View>\n              {windows.map((window) => {",
      "              <View className=\"flex-row items-center gap-1 px-1\">\n                <Pressable\n                  accessibilityRole=\"button\"\n                  accessibilityState={{ expanded: !collapsed }}\n                  onPress={() => layout.toggle(pool.driver)}\n                  className=\"min-h-11 min-w-0 flex-1 flex-row items-center gap-2 active:opacity-60\"\n                >\n                  <SymbolView\n                    name={collapsed ? \"chevron.right\" : \"chevron.down\"}\n                    size={12}\n                    tintColorClassName=\"accent-foreground-muted\"\n                  />\n                  <ProviderIcon provider={pool.driver} size={18} />\n                  <Text numberOfLines={1} className=\"shrink text-base font-t3-medium text-foreground\">\n                    {label}\n                  </Text>\n                  {collapsed ? (\n                    <Text numberOfLines={1} className=\"shrink text-xs tabular-nums text-foreground-muted\">\n                      {windows.map((window) => `${window.remainingPercent}%`).join(\" \u00b7 \")} left\n                    </Text>\n                  ) : null}\n                </Pressable>\n                {([[-1, \"chevron.up\", \"up\"], [1, \"chevron.down\", \"down\"]] as const).map(([delta, symbol, word]) => {\n                  const disabled = delta === -1 ? index === 0 : index === pools.length - 1;\n                  return (\n                    <Pressable\n                      key={word}\n                      accessibilityRole=\"button\"\n                      accessibilityLabel={`Move ${label} ${word}`}\n                      disabled={disabled}\n                      onPress={() => layout.move(pools.map((entry) => entry.driver), pool.driver, delta)}\n                      className=\"size-11 items-center justify-center active:opacity-60\"\n                      style={{ opacity: disabled ? 0.3 : 1 }}\n                    >\n                      <SymbolView name={symbol} size={14} tintColorClassName=\"accent-foreground-muted\" />\n                    </Pressable>\n                  );\n                })}\n              </View>\n              {(collapsed ? [] : windows).map((window) => {", 'replace'],
    ['import { msg, T, useGT, useMessages, Var } from "gt-react-native";',
      'import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react-native";\nimport { paceForecast, paceForecastText, type PaceStage } from "@t3tools/shared/rubatoUsagePace";',
      'replace'],
    ['  cursorUsageWindowDetails,\n} from "@t3tools/shared/usageLimitsCopy";',
      '  cursorUsageWindowDetails,\n  formatDuration,\n} from "@t3tools/shared/usageLimitsCopy";',
      'replace'],
    ['  readonly timeLeft: number | null;\n  readonly children: ReactNode;\n}) {',
      '  readonly timeLeft: number | null;\n  readonly children: ReactNode;\n  readonly stage?: PaceStage | undefined;\n}) {',
      'replace'],
    ['function PaceGap({\n  timeLeft,\n  children,\n}', 'function PaceGap({\n  timeLeft,\n  children,\n  stage,\n}', 'replace'],
    ['          className="absolute top-0.5 bottom-0.5 w-0.5 rounded-full bg-foreground"',
      '          className={PACE_TICK[stage ?? "on"]}', 'replace'],
    ['<PaceGap timeLeft={timeLeft}>', '<PaceGap timeLeft={timeLeft} stage={paceForecast(window, now)?.stage}>', 'replace'],
    ['            <Text\n              numberOfLines={1}\n              className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"\n            >\n              {accountName(account, m)}\n            </Text>',
      '            <View className="min-w-0 flex-1">\n              <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">\n                {accountName(account, m)}\n              </Text>\n              <PaceForecastText window={window} now={now} />\n            </View>',
      'replace'],
    ['{inlineLabels ? null : legend}',
      '{inlineLabels ? (\n            <View className="flex-row gap-1">\n              {pool.columns.map(({ account, window }) => (\n                <View key={account.key} className="min-w-0 flex-1 px-0.5">\n                  <PaceForecastText window={window} now={now} />\n                </View>\n              ))}\n            </View>\n          ) : (\n            legend\n          )}',
      'replace'],
    ['              {reset && reset.restoresPercent > 0 ? (',
      '              <PaceForecastText\n                window={window}\n                now={now}\n                className="text-sm text-foreground-muted"\n              />\n'],
    ['function AccountSegment({', FORECAST],
  ],
};
