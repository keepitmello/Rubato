// The phone's Usage page tells, like the desktop's (usage-limits-edits.mjs), how far each
// account's spend is off an even pace and when it runs out at the speed so far, and colours
// T3's even-pace tick red in deficit and green in reserve. The reading and its wording are
// shared with the desktop: packages/shared/src/rubatoUsagePace.ts (overlay).
//
//   legend rows      the forecast line under each account's name
//   wide bars        a forecast row under the bar, since the legend is hidden there
//   account screen   the same line under "Even pace"
//   usage kinds      Gemini and DeepSeek in the history's provider list
//   limits layout    each provider's heading folds it, moves it up or down, and opens its windows to
//                    switch each on or off and order them, kept in the phone's preferences
//                    (rubato-shell/usageLayout.ts, with its meaning shared with the desktop)

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
    ['import * as Context from "effect/Context";\n',
      'import { parseUsageLayout } from "@t3tools/shared/rubatoUsageLayout";\n'],
    ["  readonly collapsedProjectGroups?: readonly string[];\n",
      "  /** Rubato: the Usage page's provider order, folds and windows (rubato-shell/usageLayout.ts). */\n  readonly rubatoUsageLayout?: import(\"@t3tools/shared/rubatoUsageLayout\").UsageLayout;\n"],
    ["    collapsedProjectGroups?: readonly string[];\n",
      "    rubatoUsageLayout?: import(\"@t3tools/shared/rubatoUsageLayout\").UsageLayout;\n"],
    ["  if (Array.isArray(parsed.collapsedProjectGroups)) {",
      "  const rubatoUsageLayout = parseUsageLayout(parsed.rubatoUsageLayout);\n  if (rubatoUsageLayout) preferences.rubatoUsageLayout = rubatoUsageLayout;\n"],
  ],
  [FILE]: [
    ["import { SymbolView } from \"../../components/ui/AppSymbol\";\n",
      "import { ThemedSwitch } from \"../../components/ui/ThemedSwitch\";\nimport { useRubatoUsageLayout } from \"../rubato-shell/usageLayout\";\n"],
    ["  collectLimitPools,\n  displayLimitWindows,\n  paceRemainingPercent,",
      "  collectLimitPools,\n  paceRemainingPercent,", 'replace'],
    ["  const pools = collectLimitPools(collectLimitAccounts(selected), now);",
      "  // Rubato: show the same windows as the desktop, in the order and folds the person left.\n  const layout = useRubatoUsageLayout();\n  // The provider whose windows are being switched and ordered, if any.\n  const [editingDriver, setEditingDriver] = useState<string | null>(null);\n  const pools = layout.arrange(\n    collectLimitPools(collectLimitAccounts(selected), now).filter((pool) => layout.keepsPool(pool)),\n  );", 'replace'],
    ["      {pools.map((pool) => {\n        const windows = displayLimitWindows(pool);",
      "      {pools.map((pool, index) => {\n        const windows = layout.windowsOf(pool);\n        const collapsed = layout.isCollapsed(pool.driver);\n        const editing = editingDriver === pool.driver && !collapsed;\n        const label = providerClients.get(pool.driver)?.label ?? pool.driver;", 'replace'],
    ["              <View className=\"flex-row items-center gap-2 px-1\">\n                <ProviderIcon provider={pool.driver} size={18} />\n                <Text className=\"text-base font-t3-medium text-foreground\">\n                  {providerClients.get(pool.driver)?.label ?? pool.driver}\n                </Text>\n              </View>\n              {windows.map((window) => {",
      "              <View className=\"flex-row items-center gap-1 px-1\">\n                <Pressable\n                  accessibilityRole=\"button\"\n                  accessibilityState={{ expanded: !collapsed }}\n                  onPress={() => layout.toggle(pool.driver)}\n                  className=\"min-h-11 min-w-0 flex-1 flex-row items-center gap-2 active:opacity-60\"\n                >\n                  <SymbolView\n                    name={collapsed ? \"chevron.right\" : \"chevron.down\"}\n                    size={12}\n                    tintColorClassName=\"accent-foreground-muted\"\n                  />\n                  <ProviderIcon provider={pool.driver} size={18} />\n                  <Text numberOfLines={1} className=\"shrink text-base font-t3-medium text-foreground\">\n                    {label}\n                  </Text>\n                  {collapsed ? (\n                    <Text numberOfLines={1} className=\"shrink text-xs tabular-nums text-foreground-muted\">\n                      {windows.map((window) => `${window.remainingPercent}%`).join(\" \u00b7 \")} left\n                    </Text>\n                  ) : null}\n                </Pressable>\n                {collapsed ? null : (\n                  <Pressable\n                    accessibilityRole=\"button\"\n                    accessibilityLabel={`Choose ${label} limits`}\n                    accessibilityState={{ selected: editing }}\n                    onPress={() => setEditingDriver(editing ? null : pool.driver)}\n                    className=\"size-11 items-center justify-center active:opacity-60\"\n                  >\n                    <SymbolView\n                      name={editing ? \"checkmark\" : \"slider.horizontal.3\"}\n                      size={14}\n                      tintColorClassName={editing ? \"accent-focus\" : \"accent-foreground-muted\"}\n                    />\n                  </Pressable>\n                )}\n                {([[-1, \"chevron.up\", \"up\"], [1, \"chevron.down\", \"down\"]] as const).map(([delta, symbol, word]) => {\n                  const disabled = delta === -1 ? index === 0 : index === pools.length - 1;\n                  return (\n                    <Pressable\n                      key={word}\n                      accessibilityRole=\"button\"\n                      accessibilityLabel={`Move ${label} ${word}`}\n                      disabled={disabled}\n                      onPress={() => layout.move(pools.map((entry) => entry.driver), pool.driver, delta)}\n                      className=\"size-11 items-center justify-center active:opacity-60\"\n                      style={{ opacity: disabled ? 0.3 : 1 }}\n                    >\n                      <SymbolView name={symbol} size={14} tintColorClassName=\"accent-foreground-muted\" />\n                    </Pressable>\n                  );\n                })}\n              </View>\n              {editing ? <WindowChoices pool={pool} layout={layout} /> : null}\n              {(collapsed || editing ? [] : windows).map((window) => {", 'replace'],
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
    ['function AccountSegment({', FORECAST + "// Rubato: a provider's windows with a switch each, and up and down among the shown ones.\nfunction WindowChoices({\n  pool,\n  layout,\n}: {\n  readonly pool: Parameters<ReturnType<typeof useRubatoUsageLayout>[\"windowsOf\"]>[0];\n  readonly layout: ReturnType<typeof useRubatoUsageLayout>;\n}) {\n  const choices = layout.windowChoicesOf(pool);\n  const shown = choices.filter((choice) => choice.shown).map((choice) => choice.window.id);\n  return (\n    <View className=\"gap-1 rounded-xl border border-border-subtle px-3 py-1\">\n      <Text className=\"pt-2 text-xs text-foreground-muted\">Shown limits</Text>\n      {choices.map(({ window, shown: on }) => {\n        const position = shown.indexOf(window.id);\n        return (\n          <View key={window.id} className=\"min-h-11 flex-row items-center gap-1\">\n            <Text numberOfLines={2} className=\"min-w-0 flex-1 text-sm text-foreground\">\n              {window.label}\n            </Text>\n            {([[-1, \"chevron.up\", \"up\"], [1, \"chevron.down\", \"down\"]] as const).map(([delta, symbol, word]) => {\n              const disabled = !on || (delta === -1 ? position <= 0 : position >= shown.length - 1);\n              return (\n                <Pressable\n                  key={word}\n                  accessibilityRole=\"button\"\n                  accessibilityLabel={`Move ${window.label} ${word}`}\n                  disabled={disabled}\n                  onPress={() => layout.moveWindow(pool.driver, shown, window.id, delta)}\n                  className=\"size-11 items-center justify-center active:opacity-60\"\n                  style={{ opacity: disabled ? 0.3 : 1 }}\n                >\n                  <SymbolView name={symbol} size={14} tintColorClassName=\"accent-foreground-muted\" />\n                </Pressable>\n              );\n            })}\n            <ThemedSwitch\n              value={on}\n              onValueChange={(value) => layout.showWindow(pool.driver, window.id, value)}\n              accessibilityLabel={`Show ${window.label}`}\n            />\n          </View>\n        );\n      })}\n    </View>\n  );\n}\n\n"],
  ],
};
