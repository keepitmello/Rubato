// The phone's Usage page tells, like the desktop's (usage-limits-edits.mjs), how far each
// account's spend is off an even pace and when it runs out at the speed so far, and colours
// T3's even-pace tick red in deficit and green in reserve. The reading and its wording are
// shared with the desktop: packages/shared/src/rubatoUsagePace.ts (overlay).
//
//   legend rows      the forecast line under each account's name
//   wide bars        a forecast row under the bar, since the legend is hidden there
//   account screen   the same line under "Even pace"

export const mobileUsageOverlays = [];

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
  [FILE]: [
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
