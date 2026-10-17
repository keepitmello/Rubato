// The Stats page: what the local session logs say about how this person works
// with Rubato. The server half (Rubato's src/stats/service.mjs) does the reading
// and counting; this file only draws, and moves things when the numbers change.
import { useAtomValue } from "@effect/atom-react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../lib/utils";
import { primaryServerProvidersAtom } from "../state/server";
import { type StatsAnswer, type StatsPeriod, type StatsPeriodName, type StatsReady, rubatoStats } from "../state/rubatoStats";
import { useReadyEnvironmentId } from "./settings/RubatoMemorySettings";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import {
  FAMILY_COLORS,
  type Highlight,
  type KnownModel,
  WEEKDAYS_MONDAY_FIRST,
  attendanceWeeks,
  cacheShare,
  clock,
  compactNumber,
  daysSinceFirst,
  duration,
  highlights,
  hourLabel,
  hours,
  mergeModels,
  modelFamily,
  modelName,
  percent,
  shortDate,
  totalTokens,
  weekday,
  wholeNumber,
} from "./rubatoStatsFormat";

const PERIODS: ReadonlyArray<{ value: StatsPeriodName; label: string; caption: string }> = [
  { value: "week", label: "Last 7 days", caption: "Last 7 days" },
  { value: "month", label: "Last 30 days", caption: "Last 30 days" },
  { value: "all", label: "All time", caption: "All time" },
];
const EASE = "cubic-bezier(.22,1,.36,1)";
const HIGHLIGHT_MS = 6000;
const LEVEL_ORDER = ["max", "xhigh", "high", "medium", "low", "minimal", "off"] as const;
const LEVEL_COLORS: Record<string, string> = {
  max: "#f472b6",
  xhigh: "#a78bfa",
  high: "#818cf8",
  medium: "#6aa7ff",
  low: "#3fcfb8",
  minimal: "#94a3b8",
  off: "#64748b",
};

// Keyframes the page needs; Tailwind's theme has none of these.
const KEYFRAMES = `
@keyframes rubato-stats-run { from { left: 0 } to { left: calc(var(--to, 100%) - 7px) } }
@keyframes rubato-stats-progress { from { transform: scaleX(0) } to { transform: scaleX(1) } }
@keyframes rubato-stats-rise { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
@keyframes rubato-stats-flicker { 0%,100% { transform: scale(1) rotate(-2deg) } 50% { transform: scale(1.1) rotate(3deg) } }
@media (prefers-reduced-motion: reduce) { .rubato-stats * { animation: none !important; transition: none !important } }
`;

/* ------------------------------------------------------------------ data */

function useStats() {
  const environmentId = useReadyEnvironmentId();
  const [answer, setAnswer] = useState<StatsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    rubatoStats
      .summary(environmentId)
      .then((next) => {
        if (cancelled) return;
        setAnswer(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, tick]);
  // Ask again while the server is still reading logs or writing a card.
  useEffect(() => {
    if (!answer) return;
    const writing =
      answer.status === "ready" && Object.values(answer.periods).some((period) => period.think?.cardState === "writing");
    const delay = answer.status === "scanning" ? 800 : answer.refreshing || writing ? 4000 : null;
    if (delay === null) return;
    const timer = setTimeout(() => setTick((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [answer]);
  return { answer, error };
}

function useKnownModels(): KnownModel[] {
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(
    () => providers.flatMap((provider) => provider.models.map((model) => ({ slug: model.slug, name: model.name }))),
    [providers],
  );
}

/* ---------------------------------------------------------------- motion */

const easeOut = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/** The value, counted from where it last stood to where it is now. */
function useTweened(target: number, durationMs = 1100): number {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const value = origin + (target - origin) * easeOut(t);
      from.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);
  return shown;
}

function Counter(props: { value: number; format?: (value: number) => string; className?: string }) {
  const shown = useTweened(props.value);
  return <span className={props.className}>{(props.format ?? wholeNumber)(shown)}</span>;
}

/** False on the first frame, true after: lets widths and heights grow from zero. */
function useEntered(): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return entered;
}

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}
type ShowTip = (event: React.MouseEvent, content: ReactNode) => void;

/* ----------------------------------------------------------------- pieces */

function Section(props: { title: string; caption?: ReactNode; aside?: ReactNode; children: ReactNode; delay: number }) {
  return (
    <section className="mt-10" style={{ animation: `rubato-stats-rise .8s ${EASE} ${props.delay}s both` }}>
      <div className="flex items-center gap-3 border-b border-border pb-3">
        <h2 className="text-[15px] font-semibold">{props.title}</h2>
        {props.caption ? <span className="truncate text-xs text-muted-foreground">{props.caption}</span> : null}
        {props.aside ? <div className="ms-auto">{props.aside}</div> : null}
      </div>
      {props.children}
    </section>
  );
}

function Bar(props: { share: number; color: string; delay: number; height?: number; under?: number }) {
  const entered = useEntered();
  const height = props.height ?? 8;
  return (
    <div className="relative overflow-hidden rounded-[5px] bg-foreground/[0.05]" style={{ height }}>
      {props.under !== undefined ? (
        <div
          className="absolute inset-y-0 left-0 rounded-[5px] opacity-35"
          style={{ background: props.color, width: entered ? `${props.under * 100}%` : 0, transition: `width 1.1s ${EASE} ${props.delay}s` }}
        />
      ) : null}
      <div
        className="absolute inset-y-0 left-0 rounded-[5px]"
        style={{ background: props.color, width: entered ? `${props.share * 100}%` : 0, transition: `width 1.1s ${EASE} ${props.delay}s` }}
      />
    </div>
  );
}

function Dot(props: { color: string }) {
  return <span className="inline-block size-[7px] shrink-0 rounded-full" style={{ background: props.color }} />;
}

function Sparkline(props: { values: ReadonlyArray<number>; color: string }) {
  const width = 120;
  const height = 26;
  const max = Math.max(1, ...props.values);
  const points = props.values.map((value, index) => [
    (index / Math.max(1, props.values.length - 1)) * width,
    height - 2 - (value / max) * (height - 4),
  ]);
  const line = `M${points.map(([x, y]) => `${x!.toFixed(1)},${y!.toFixed(1)}`).join("L")}`;
  return (
    <svg width={width} height={height} className="mt-2.5 block" aria-hidden>
      <path d={`${line}L${width},${height}L0,${height}Z`} fill={props.color} opacity={0.08} />
      <path
        key={line}
        d={line}
        fill="none"
        stroke={props.color}
        strokeWidth={1.4}
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        style={{ strokeDashoffset: 1, animation: `rubato-stats-draw 1.3s ${EASE} forwards` }}
      />
      <style>{"@keyframes rubato-stats-draw { to { stroke-dashoffset: 0 } }"}</style>
    </svg>
  );
}

/* ------------------------------------------------------------------ strip */

function Strip(props: { stats: StatsReady; period: StatsPeriod; name: StatsPeriodName; tip: ShowTip }) {
  const { stats, period } = props;
  const share = cacheShare(period);
  const values = period.daily.map(([, count]) => count);
  return (
    <div
      className="mt-4 grid grid-cols-[0.9fr_1fr_1.1fr_1.1fr_1.6fr] border-y border-border max-xl:grid-cols-3 max-lg:grid-cols-2"
      style={{ animation: `rubato-stats-rise .8s ${EASE} .05s both` }}
    >
      <div className="py-5 pe-5">
        <div className="text-xs text-muted-foreground">Sessions</div>
        <Counter value={period.sessions} className="mt-1.5 block text-[32px] font-bold leading-tight tracking-tight" />
        <Sparkline values={values} color="#6aa7ff" />
      </div>
      <div className="border-s border-border px-5 py-5">
        <div className="text-xs text-muted-foreground">Messages you sent</div>
        <Counter value={period.turns} className="mt-1.5 block text-[32px] font-bold leading-tight tracking-tight" />
        <Sparkline values={values} color="#ff8a5b" />
      </div>
      <div className="border-s border-border px-5 py-5">
        <div className="text-xs text-muted-foreground">Time worked</div>
        <Counter value={period.work.seconds} format={hours} className="mt-1.5 block text-[32px] font-bold leading-tight tracking-tight" />
        <div className="mt-2 whitespace-nowrap text-[11.5px] text-muted-foreground/80">
          <b className="font-semibold text-foreground">{hours(period.work.averageSeconds)}</b>/day
          {period.work.seconds > 0 && period.work.agentSeconds > period.work.seconds * 1.05 ? (
            <> · <b className="font-semibold text-foreground">{(period.work.agentSeconds / period.work.seconds).toFixed(1)}×</b> parallel</>
          ) : null}
        </div>
        <Sparkline values={period.work.daily.map(([, seconds]) => seconds)} color="#5fe0d0" />
      </div>
      <div className="border-s border-border px-5 py-5">
        <div className="text-xs text-muted-foreground">Tokens processed</div>
        <Counter value={totalTokens(period)} format={compactNumber} className="mt-1.5 block text-[32px] font-bold leading-tight tracking-tight" />
        <div className="mt-3 flex h-1 overflow-hidden rounded bg-foreground/[0.06]">
          <i className="block h-full" style={{ width: `${share * 100}%`, background: "linear-gradient(90deg,#3fcfb8,#6aa7ff)", transition: `width 1.3s ${EASE}` }} />
          <i className="block h-full bg-[#ff8a5b]" style={{ width: `${(1 - share) * 100}%`, transition: `width 1.3s ${EASE}` }} />
        </div>
        <div className="mt-2 text-[11.5px] text-muted-foreground/80">
          <span className="text-[#3fcfb8]">●</span> Cached <Counter value={share * 100} format={(v) => `${Math.round(v)}%`} className="font-semibold text-foreground" />
        </div>
      </div>
      <div className="flex items-start gap-5 border-s border-border px-5 py-5">
        <div>
          <div className="text-xs text-muted-foreground">Streak</div>
          <div className="mt-1.5 text-[32px] font-bold leading-tight tracking-tight">
            <Counter value={stats.currentStreak} />
            <small className="ms-1 text-sm font-semibold tracking-normal text-muted-foreground">{stats.currentStreak === 1 ? "day" : "days"}</small>
            {stats.currentStreak >= 3 ? (
              <span className="ms-1 inline-block text-xl" style={{ animation: "rubato-stats-flicker 1.6s ease-in-out infinite", transformOrigin: "50% 90%" }}>
                🔥
              </span>
            ) : null}
          </div>
          <div className="mt-2 text-[11.5px] text-muted-foreground/80">
            {stats.activeDays}/{daysSinceFirst(stats)} days · best {stats.bestStreak}
          </div>
        </div>
        <Attendance stats={stats} days={period.days} tip={props.tip} />
      </div>
    </div>
  );
}

/** GitHub-style grid of every day since the first one; the chosen period stays lit. */
function Attendance(props: { stats: StatsReady; days: number | null; tip: ShowTip }) {
  const entered = useEntered();
  const days = useMemo(() => attendanceWeeks(props.stats), [props.stats]);
  const counts = days.map((day) => day.count).filter(Boolean).toSorted((a, b) => a - b);
  const high = counts[Math.floor(counts.length * 0.9)] ?? 1;
  const today = new Date(`${props.stats.today}T12:00:00`).getTime();
  return (
    <div className="grid grid-flow-col grid-rows-[repeat(7,10px)] gap-[3px]">
      {days.map(({ day, count }, index) => {
        const age = (today - new Date(`${day}T12:00:00`).getTime()) / 86_400_000;
        const outside = props.days !== null && age >= props.days;
        const level = Math.min(1, count / Math.max(1, high));
        return (
          <i
            key={day}
            className="block size-2.5 rounded-[2.5px]"
            onMouseMove={(event) => props.tip(event, <>{shortDate(day)} · <b>{wholeNumber(count)}</b> messages</>)}
            style={{
              background: count ? `rgba(63,207,150,${(0.22 + level * 0.78).toFixed(2)})` : "color-mix(in srgb, currentColor 7%, transparent)",
              opacity: outside ? 0.22 : 1,
              transform: entered ? "scale(1)" : "scale(0)",
              transition: `transform .45s ${EASE} ${index * 9}ms, opacity .4s, background .4s`,
            }}
          />
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- ticker */

function Ticker(props: { items: Highlight[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = props.items.length;
  const current = count ? props.items[index % count]! : null;
  useEffect(() => setIndex(0), [props.items]);
  if (!current) return null;
  const go = (step: number) => setIndex((value) => (value + step + count) % count);
  return (
    <div
      className="relative mt-6 h-[118px] cursor-pointer select-none overflow-hidden rounded-xl border border-border/60 bg-foreground/[0.025]"
      style={{ animation: `rubato-stats-rise .8s ${EASE} .12s both` }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={() => go(1)}
    >
      <div
        className="pointer-events-none absolute -left-20 -top-28 size-[360px] rounded-full opacity-[0.16] blur-[60px]"
        style={{ background: current.color, transition: "background .8s" }}
      />
      {props.items.map((item, position) => (
        <TickerCard key={item.key} item={item} active={position === index % count} />
      ))}
      <div className="absolute right-4 top-1/2 z-10 flex -translate-y-1/2 items-center gap-2 text-[11.5px] text-muted-foreground/70">
        <TickerButton label="Previous highlight" onClick={() => go(-1)}>
          <ChevronLeftIcon className="size-3.5" />
        </TickerButton>
        <span className="tabular-nums">
          {(index % count) + 1} / {count}
        </span>
        <TickerButton label="Next highlight" onClick={() => go(1)}>
          <ChevronRightIcon className="size-3.5" />
        </TickerButton>
      </div>
      <div
        key={`${current.key}-${index}`}
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left"
        style={{
          background: current.color,
          animation: `rubato-stats-progress ${HIGHLIGHT_MS}ms linear forwards`,
          animationPlayState: paused ? "paused" : "running",
        }}
        onAnimationEnd={() => go(1)}
      />
    </div>
  );
}

function TickerButton(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      className="grid size-6 place-items-center rounded-md border border-border text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}

function TickerCard(props: { item: Highlight; active: boolean }) {
  const { item, active } = props;
  return (
    <div
      className="absolute inset-0 flex items-center gap-6 pe-32 ps-7"
      aria-hidden={!active}
      style={{
        opacity: active ? 1 : 0,
        transform: active ? "none" : "translateY(10px)",
        transition: `opacity .55s ${EASE}, transform .7s ${EASE}`,
        pointerEvents: active ? "auto" : "none",
      }}
    >
      <div className="min-w-[132px] text-right leading-none" style={{ color: item.color }}>
        {active ? <Counter value={item.value} className="text-[46px] font-extrabold tracking-[-1.8px]" /> : <span className="text-[46px] font-extrabold tracking-[-1.8px]">0</span>}
        <small className="mt-1.5 block text-[11.5px] font-semibold tracking-normal text-muted-foreground">{item.unit}</small>
      </div>
      <div className="my-6 w-px self-stretch bg-border" />
      <div className="min-w-0">
        <div className="text-[11.5px] text-muted-foreground">{item.label}</div>
        <div className="mt-1 truncate text-[17px] font-semibold tracking-[-0.2px]">{item.headline}</div>
        <div className="mt-1 line-clamp-2 max-w-[640px] text-[12.8px] leading-relaxed text-muted-foreground">{item.detail}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- rhythm */

type RhythmMode = "day" | "work" | "hour";

function Rhythm(props: { period: StatsPeriod; mode: RhythmMode; tip: ShowTip }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const cell = Math.min((width - 26) / 24, 40);
  const height = props.mode !== "hour" ? 230 : 74 + 7 * cell + 22;
  return (
    <div ref={box} className="relative mt-4" style={{ height: width ? height : 230, transition: `height .6s ${EASE}` }}>
      {width > 0 ? (
        props.mode !== "hour" ? (
          <DayBars
            key={`${props.period.days}-${props.mode}`}
            series={props.mode === "work" ? workSeries(props.period) : messageSeries(props.period)}
            width={width}
            tip={props.tip}
          />
        ) : (
          <HourGrid key={`${props.period.days}-hour`} period={props.period} width={width} cell={cell} tip={props.tip} />
        )
      ) : null}
    </div>
  );
}

interface DaySeries {
  /** [day, value, value behind it] — the second bar is drawn lighter, behind the first. */
  readonly rows: ReadonlyArray<readonly [string, number, number?]>;
  readonly format: (value: number) => string;
  readonly unit: string;
  readonly colors: readonly [string, string];
  readonly highlight: string | null;
  readonly behindLabel?: string;
}

/** Messages per day, from the period. */
function messageSeries(period: StatsPeriod): DaySeries {
  return {
    rows: period.daily,
    format: (value) => wholeNumber(value),
    unit: "messages",
    colors: ["#ffb86b", "#ff7a59"],
    highlight: period.busiest?.day ?? null,
  };
}

/** Hours worked per day: on the clock in front, all sessions added up behind. */
function workSeries(period: StatsPeriod): DaySeries {
  return {
    rows: period.work.daily,
    format: (value) => hours(value),
    unit: "worked",
    colors: ["#5fe0d0", "#3f9fd0"],
    highlight: period.work.longestDay?.day ?? null,
    behindLabel: "all sessions added",
  };
}

function DayBars(props: { series: DaySeries; width: number; tip: ShowTip }) {
  const entered = useEntered();
  const { rows, format, colors, highlight } = props.series;
  const gradient = `rubato-stats-bar-${colors[0].slice(1)}`;
  const height = 230;
  const base = height - 22;
  const max = Math.max(1, ...rows.map(([, value, behind]) => Math.max(value, behind ?? 0)));
  const n = rows.length;
  const gap = n > 40 ? 3 : n > 10 ? 5 : 14;
  const barWidth = Math.max(1, (props.width - gap * (n - 1)) / n);
  const active = rows.filter(([, value]) => value > 0);
  const average = active.reduce((sum, [, value]) => sum + value, 0) / (active.length || 1);
  const averageY = base - (average / max) * (base - 10);
  const every = Math.ceil(n / 8);
  const grow = (index: number) => `y .8s ${EASE} ${index * (n > 40 ? 10 : 40)}ms, height .8s ${EASE} ${index * (n > 40 ? 10 : 40)}ms`;
  return (
    <svg className="absolute inset-0 overflow-visible" width={props.width} height={height}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={colors[0]} />
          <stop offset="1" stopColor={colors[1]} />
        </linearGradient>
      </defs>
      <line x1={0} x2={props.width} y1={base + 0.5} y2={base + 0.5} className="stroke-border" />
      <line x1={0} x2={props.width} y1={averageY} y2={averageY} stroke="currentColor" strokeOpacity={0.18} strokeDasharray="3 4" />
      <text x={2} y={averageY - 5} className="fill-muted-foreground/70 text-[10.5px]">
        avg {format(average)}
      </text>
      {rows.map(([day, value, behind], index) => {
        const barHeight = Math.max(2, (value / max) * (base - 10));
        const behindHeight = behind ? Math.max(2, (behind / max) * (base - 10)) : 0;
        return (
          <g
            key={day}
            onMouseMove={(event) =>
              props.tip(
                event,
                <>
                  {weekday(day).slice(0, 3)}, {shortDate(day)} · <b>{format(value)}</b> {props.series.unit}
                  {behind && behind > value ? <> · {format(behind)} {props.series.behindLabel}</> : null}
                </>,
              )
            }
          >
            {behindHeight > 0 ? (
              <rect
                x={index * (barWidth + gap)}
                y={entered ? base - behindHeight : base}
                width={barWidth}
                height={entered ? behindHeight : 0}
                rx={Math.min(3, barWidth / 2)}
                fill={colors[1]}
                opacity={0.22}
                style={{ transition: grow(index) }}
              />
            ) : null}
            <rect
              x={index * (barWidth + gap)}
              y={entered ? base - barHeight : base}
              width={barWidth}
              height={entered ? barHeight : 0}
              rx={Math.min(3, barWidth / 2)}
              fill={highlight === day ? "#ffd29a" : `url(#${gradient})`}
              style={{ transition: grow(index) }}
            />
          </g>
        );
      })}
      {rows.map(([day], index) =>
        index === n - 1 || (index % every === 0 && n - 1 - index >= every * 0.6) ? (
          <text key={`label-${day}`} x={index * (barWidth + gap) + barWidth / 2} y={height - 4} textAnchor="middle" className="fill-muted-foreground/70 text-[10.5px]">
            {shortDate(day)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function heatColor(level: number): string {
  const stops = [
    [44, 58, 92],
    [106, 90, 205],
    [236, 110, 120],
    [255, 184, 107],
  ] as const;
  const t = level * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  const rgb = stops[i]!.map((value, k) => Math.round(value + (stops[i + 1]![k]! - value) * f));
  return `rgba(${rgb.join(",")},${(0.35 + level * 0.65).toFixed(2)})`;
}

function HourGrid(props: { period: StatsPeriod; width: number; cell: number; tip: ShowTip }) {
  const entered = useEntered();
  const { heat, hourly } = props.period;
  const { cell } = props;
  const labelWidth = 26;
  const gap = 4;
  const top = 74;
  const offset = Math.max(0, (props.width - labelWidth - 24 * cell) / 2);
  const hourMax = Math.max(1, ...hourly);
  const peakHour = hourly.indexOf(hourMax);
  const nonzero = heat.flat().filter(Boolean).toSorted((a, b) => a - b);
  const high = nonzero[Math.floor(nonzero.length * 0.95)] ?? 1;
  const height = top + 7 * cell + 22;
  const x = (hour: number) => offset + labelWidth + hour * cell;
  return (
    <svg className="absolute inset-0 overflow-visible" width={props.width} height={height}>
      {hourly.map((count, hour) => {
        const barHeight = Math.max(1.5, (count / hourMax) * (top - 16));
        return (
          <rect
            key={`h${hour}`}
            x={x(hour) + gap / 2}
            y={entered ? top - 8 - barHeight : top - 8}
            width={cell - gap}
            height={entered ? barHeight : 0}
            rx={2}
            fill={hour === peakHour ? "#ffd29a" : "url(#rubato-stats-hour)"}
            opacity={hour === peakHour ? 1 : 0.75}
            style={{ transition: `y .7s ${EASE} ${hour * 22}ms, height .7s ${EASE} ${hour * 22}ms` }}
            onMouseMove={(event) => props.tip(event, <>{hourLabel(hour)} · <b>{wholeNumber(count)}</b> messages</>)}
          />
        );
      })}
      <defs>
        <linearGradient id="rubato-stats-hour" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb86b" />
          <stop offset="1" stopColor="#ff7a59" />
        </linearGradient>
      </defs>
      {heat.map((row, day) => (
        <g key={`d${day}`}>
          <text x={offset} y={top + day * cell + cell / 2 + 4} className="fill-muted-foreground/70 text-[10.5px]">
            {WEEKDAYS_MONDAY_FIRST[day]}
          </text>
          {row.map((count, hour) => {
            const level = Math.min(1, count / Math.max(1, high)) ** 1.3;
            return (
              <rect
                key={`c${day}-${hour}`}
                x={x(hour) + gap / 2}
                y={top + day * cell + gap / 2}
                width={cell - gap}
                height={cell - gap}
                rx={3}
                fill={count ? heatColor(level) : "currentColor"}
                fillOpacity={count ? 1 : 0.035}
                style={{
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  transform: entered ? "scale(1)" : "scale(0)",
                  transition: `transform .5s ${EASE} ${(hour + day * 2) * 14 + 120}ms`,
                }}
                onMouseMove={(event) => props.tip(event, <>{WEEKDAYS_MONDAY_FIRST[day]} {hourLabel(hour)} · <b>{wholeNumber(count)}</b> messages</>)}
              />
            );
          })}
        </g>
      ))}
      {[0, 6, 12, 18, 23].map((hour) => (
        <text key={`t${hour}`} x={x(hour) + cell / 2} y={top + 7 * cell + 16} textAnchor="middle" className="fill-muted-foreground/70 text-[10.5px]">
          {hourLabel(hour)}
        </text>
      ))}
    </svg>
  );
}

function rhythmCaption(period: StatsPeriod, mode: RhythmMode): ReactNode {
  if (mode === "work") {
    const { work } = period;
    if (!work.longestDay) return null;
    return (
      <>
        Longest <b className="font-semibold text-foreground">{weekday(work.longestDay.day).slice(0, 3)}, {shortDate(work.longestDay.day)} · {hours(work.longestDay.seconds)}</b>
        <span className="mx-2">·</span>Daily average <b className="font-semibold text-foreground">{hours(work.averageSeconds)}</b>
        <span className="mx-2">·</span>Total <b className="font-semibold text-foreground">{hours(work.seconds)}</b>
      </>
    );
  }
  if (mode === "day") {
    if (!period.busiest) return null;
    const activeDays = period.daily.filter(([, count]) => count > 0).length || 1;
    return (
      <>
        Busiest <b className="font-semibold text-foreground">{weekday(period.busiest.day).slice(0, 3)}, {shortDate(period.busiest.day)} · {wholeNumber(period.busiest.turns)}</b>
        <span className="mx-2">·</span>Daily average <b className="font-semibold text-foreground">{Math.round(period.turns / activeDays)}</b>
      </>
    );
  }
  const peak = period.hourly.indexOf(Math.max(...period.hourly));
  let hottest: [number, number, number] = [0, 0, 0];
  period.heat.forEach((row, day) => row.forEach((count, hour) => { if (count > hottest[0]) hottest = [count, day, hour]; }));
  return (
    <>
      Peak hour <b className="font-semibold text-foreground">{hourLabel(peak)}</b>
      <span className="mx-2">·</span>Hottest slot <b className="font-semibold text-foreground">{WEEKDAYS_MONDAY_FIRST[hottest[1]]} {hourLabel(hottest[2])}</b>
      <span className="mx-2">·</span>After midnight <b className="font-semibold text-foreground">{percent(period.nightShare)}</b>
    </>
  );
}

/* ---------------------------------------------------------------- models */

function Models(props: { period: StatsPeriod; known: KnownModel[]; tip: ShowTip }) {
  const models = mergeModels(props.period.models, props.known);
  const total = models.reduce((sum, model) => sum + model.tokens, 0) || 1;
  const top = models.slice(0, 6);
  const max = top[0]?.tokens ?? 1;
  return (
    <div>
      <Subhead title="Token share" hint="Lighter part is cache" />
      {top.map((model, index) => {
        const color = FAMILY_COLORS[modelFamily(model.id)];
        return (
          <div
            key={model.name}
            className="grid grid-cols-[176px_1fr_96px] items-center gap-3 py-[7px] text-[12.5px]"
            onMouseMove={(event) =>
              props.tip(event, <>{model.name} · cache {percent(model.cacheRead / Math.max(1, model.input))} · {wholeNumber(model.calls)} calls</>)
            }
          >
            <div className="flex min-w-0 items-center gap-2" title={model.name}><Dot color={color} /><span className="truncate">{model.name}</span></div>
            <Bar share={(model.tokens - model.cacheRead) / max} under={model.tokens / max} color={color} delay={0.08 + index * 0.08} />
            <div className="text-right text-muted-foreground">
              <b className="font-semibold text-foreground">{percent(model.tokens / total)}</b> · {compactNumber(model.tokens)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Speed(props: { period: StatsPeriod; known: KnownModel[]; tip: ShowTip }) {
  const entered = useEntered();
  const rows = props.period.speed.toSorted((a, b) => b.score - a.score).slice(0, 6);
  const max = Math.max(100, ...rows.map((row) => row.score)) * 1.04;
  if (!rows.length) return <Subhead title="Speed index" hint="No timed calls in this period" />;
  return (
    <div>
      <Subhead title="Speed index" hint="GPT-5.6 Sol medium = 100" />
      {rows.map((row, index) => {
        const color = FAMILY_COLORS[modelFamily(row.model)];
        const share = (row.score / max) * 100;
        return (
          <div
            key={row.model}
            className="grid grid-cols-[176px_1fr_48px] items-center gap-3 py-[7px] text-[12.5px]"
            onMouseMove={(event) => props.tip(event, <>{modelName(row.model, props.known)} · from {wholeNumber(row.samples)} calls</>)}
          >
            <div className="flex min-w-0 items-center gap-2"><Dot color={color} /><span className="truncate">{modelName(row.model, props.known)}</span></div>
            <div className="relative h-[18px] overflow-hidden rounded-[5px] bg-foreground/[0.03]">
              <div
                className="absolute inset-y-0 left-0 rounded-[5px] opacity-[0.22]"
                style={{ background: color, width: entered ? `${share}%` : 0, transition: `width 1.1s ${EASE} ${0.08 + index * 0.08}s` }}
              />
              <span
                className="absolute top-1/2 -mt-[3.5px] size-[7px] rounded-full"
                style={{
                  color,
                  background: color,
                  boxShadow: "0 0 10px 2px currentColor",
                  ["--to" as string]: `${share}%`,
                  animation: `rubato-stats-run ${(240 / row.score).toFixed(2)}s linear infinite`,
                } as CSSProperties}
              />
              <span className="absolute -inset-y-1 w-px bg-foreground/30" style={{ left: `${(100 / max) * 100}%` }} />
            </div>
            <div className="text-right font-semibold">{row.score}</div>
          </div>
        );
      })}
    </div>
  );
}

function Subhead(props: { title: string; hint?: string }) {
  return (
    <div className="mb-3 flex gap-2 text-xs text-muted-foreground">
      {props.title}
      {props.hint ? <span className="ms-auto text-[11px] text-muted-foreground/70">{props.hint}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------------- thinking */

function Thinking(props: { period: StatsPeriod; known: KnownModel[] }) {
  const think = props.period.think;
  if (!think) return <p className="text-sm text-muted-foreground">No thinking recorded in this period.</p>;
  const name = modelName(think.model, props.known);
  return (
    <div>
      <div className="text-[11.5px] text-[#a78bfa]">Longest think · {wholeNumber(think.chars)} characters</div>
      {think.card ? (
        <>
          <div className="mt-2 text-xl font-bold tracking-[-0.4px]">{think.card.headline}</div>
          <p className="mt-2 max-w-[620px] text-[13.3px] leading-[1.75] text-foreground/80">{think.card.body}</p>
        </>
      ) : (
        <>
          <div className="mt-2 text-xl font-bold tracking-[-0.4px]">“{think.title ?? think.project}”</div>
          <p className="mt-2 text-[13.3px] text-muted-foreground">
            {think.cardState === "writing" ? "Reading it to tell you what it was about…" : "No summary for this one."}
          </p>
        </>
      )}
      <div className="mt-3 text-[11.5px] text-muted-foreground/70">
        {think.card?.chips.length ? <span className="text-[#c4b5fd]">{think.card.chips.join(" · ")}</span> : null}
        {think.card?.chips.length ? <span className="mx-2">—</span> : null}
        {name} · {shortDate(think.at)} {clock(think.at)} · {think.title ?? think.project}
      </div>
    </div>
  );
}

function Levels(props: { period: StatsPeriod }) {
  const levels = LEVEL_ORDER.filter((level) => props.period.levels[level]);
  const counts = levels.map((level) => props.period.levels[level] ?? 0);
  const max = Math.max(1, ...counts);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const top = levels.toSorted((a, b) => (props.period.levels[b] ?? 0) - (props.period.levels[a] ?? 0))[0];
  return (
    <div>
      <Subhead title="Messages by thinking level" hint="The level each message went out with" />
      {levels.map((level, index) => (
        <div key={level} className="grid grid-cols-[58px_1fr_48px] items-center gap-2.5 py-[5px] text-xs">
          <div className="font-semibold" style={{ color: LEVEL_COLORS[level] }}>{level}</div>
          <Bar share={(props.period.levels[level] ?? 0) / max} color={LEVEL_COLORS[level]!} delay={0.08 + index * 0.08} height={10} />
          <div className="text-right text-muted-foreground">{wholeNumber(props.period.levels[level] ?? 0)}</div>
        </div>
      ))}
      {top && total ? (
        <div className="mt-3 text-[11.5px] text-muted-foreground/70">
          <b className="font-semibold text-foreground">{percent((props.period.levels[top] ?? 0) / total)}</b> of {wholeNumber(total)} messages went out on <b className="font-semibold text-foreground">{top}</b>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------ projects & team */

function Projects(props: { period: StatsPeriod; known: KnownModel[]; tip: ShowTip }) {
  const projects = props.period.projects.slice(0, 6);
  const max = projects[0]?.turns ?? 1;
  return (
    <div>
      <Subhead title="Projects" hint="By messages" />
      {projects.map((project, index) => (
        <div
          key={project.path ?? project.name}
          className="grid grid-cols-[140px_1fr_64px_176px] items-center gap-3 border-b border-border/50 py-2 text-[12.5px] last:border-0"
          onMouseMove={(event) => props.tip(event, <>{project.path ?? project.name} · {project.sessions} sessions · {compactNumber(project.tokens)} tokens</>)}
        >
          <div className="truncate font-semibold">{project.name}</div>
          <Bar share={project.turns / max} color="linear-gradient(90deg,#6aa7ff,#3fcfb8)" delay={0.08 + index * 0.08} />
          <div className="text-right font-semibold">{wholeNumber(project.turns)}</div>
          <div className="flex min-w-0 items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
            {project.topModel ? <><Dot color={FAMILY_COLORS[modelFamily(project.topModel)]} /><span className="truncate">{modelName(project.topModel, props.known)}</span></> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Delegation(props: { period: StatsPeriod; known: KnownModel[] }) {
  const { delegation, run } = props.period;
  const merged = new Map<string, { id: string; count: number }>();
  for (const row of delegation.models) {
    const name = modelName(row.model, props.known);
    const held = merged.get(name) ?? { id: row.model, count: 0 };
    held.count += row.count;
    merged.set(name, held);
  }
  const rows = [...merged.entries()].toSorted((a, b) => b[1].count - a[1].count).slice(0, 4);
  const max = rows[0]?.[1].count ?? 1;
  return (
    <div>
      <div className="flex items-baseline gap-9">
        <div className="text-[30px] font-bold tracking-tight">
          <Counter value={delegation.agents} />
          <small className="mt-0.5 block text-[11.5px] font-medium tracking-normal text-muted-foreground">subagents started</small>
        </div>
        <div className="text-[30px] font-bold tracking-tight">
          <Counter value={delegation.teams} />
          <small className="mt-0.5 block text-[11.5px] font-medium tracking-normal text-muted-foreground">teams formed</small>
        </div>
      </div>
      {rows.length ? (
        <>
          <div className="mb-1 mt-5 text-xs text-muted-foreground">Handed to most</div>
          {rows.map(([name, row], index) => (
            <div key={name} className="grid grid-cols-[176px_1fr_36px] items-center gap-3 py-[6px] text-[12.5px]">
              <div className="flex min-w-0 items-center gap-2"><Dot color={FAMILY_COLORS[modelFamily(row.id)]} /><span className="truncate">{name}</span></div>
              <Bar share={row.count / max} color={FAMILY_COLORS[modelFamily(row.id)]} delay={0.08 + index * 0.08} />
              <div className="text-right font-semibold">{row.count}</div>
            </div>
          ))}
        </>
      ) : null}
      {run ? (
        <div className="mt-4 border-t border-border/50 pt-3.5 text-[12.5px] leading-relaxed text-muted-foreground">
          Longest solo run: <b className="text-foreground">{wholeNumber(run.calls)} calls</b> in a row over{" "}
          <b className="text-foreground">{duration(run.seconds)}</b>, with no message from you
          <span className="text-muted-foreground/70"> · {shortDate(run.at)} · {run.title ?? run.project}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ page */

function Columns(props: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={cn(
        "grid pt-[18px] max-lg:grid-cols-1 max-lg:gap-8 [&>*+*]:border-s [&>*+*]:border-border/50 [&>*+*]:ps-8 [&>*:first-child]:pe-8 max-lg:[&>*+*]:border-s-0 max-lg:[&>*+*]:ps-0",
        props.wide ? "grid-cols-[1.5fr_1fr]" : "grid-cols-2",
      )}
    >
      {props.children}
    </div>
  );
}

export function RubatoStatsPanel() {
  const { answer, error } = useStats();
  const known = useKnownModels();
  const [periodName, setPeriodName] = useState<StatsPeriodName>("month");
  const [mode, setMode] = useState<RhythmMode>("day");
  const [tip, setTip] = useState<TipState | null>(null);
  const showTip = useCallback<ShowTip>((event, content) => setTip({ x: event.clientX, y: event.clientY, content }), []);
  const stats = answer?.status === "ready" ? answer : null;
  const period = stats?.periods[periodName] ?? null;
  const items = useMemo(() => (period ? highlights(period, known) : []), [period, known]);

  return (
    <div className="rubato-stats min-h-0 flex-1 overflow-y-auto" onMouseLeave={() => setTip(null)}>
      <style>{KEYFRAMES}</style>
      <div className="mx-auto w-full max-w-[1120px] px-8 pb-16 max-sm:px-4" onMouseMove={(event) => { if (!(event.target as Element).closest("rect,i,[class*='grid-cols']")) setTip(null); }}>
        <div className="sticky top-0 z-10 flex items-end gap-3 bg-background/85 pb-3 pt-5 backdrop-blur-md">
          <div className="text-[12.5px] text-muted-foreground">
            {stats && periodName === "all" && stats.firstDay
              ? `Since ${shortDate(stats.firstDay)} · from your local session logs`
              : `${PERIODS.find((p) => p.value === periodName)!.caption} · from your local session logs`}
            {stats?.refreshing ? <span className="ms-2 text-muted-foreground/60">Updating…</span> : null}
          </div>
          <ToggleGroup
            className="ms-auto"
            aria-label="Stats period"
            variant="segmented"
            value={[periodName]}
            onValueChange={(next) => {
              const value = next[0] as StatsPeriodName | undefined;
              if (value) setPeriodName(value);
            }}
          >
            {PERIODS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>

        {error && !stats ? <p className="mt-10 text-sm text-destructive">{error}</p> : null}
        {answer?.status === "scanning" || (!answer && !error) ? <Scanning progress={answer?.status === "scanning" ? answer.progress : null} /> : null}

        {stats && period ? (
          <>
            <Strip stats={stats} period={period} name={periodName} tip={showTip} />
            <Ticker items={items} />

            <Section
              title="Rhythm"
              caption={rhythmCaption(period, mode)}
              delay={0.2}
              aside={
                <ToggleGroup
                  aria-label="Rhythm view"
                  variant="segmented"
                  value={[mode]}
                  onValueChange={(next) => {
                    const value = next[0] as RhythmMode | undefined;
                    if (value) setMode(value);
                  }}
                >
                  <Toggle value="day">By day</Toggle>
                  <Toggle value="work">Work hours</Toggle>
                  <Toggle value="hour">By hour</Toggle>
                </ToggleGroup>
              }
            >
              <Rhythm period={period} mode={mode} tip={showTip} />
            </Section>

            <Section title="Models" caption="Who you worked with, and how fast they were" delay={0.26}>
              <Columns>
                <Models period={period} known={known} tip={showTip} />
                <Speed period={period} known={known} tip={showTip} />
              </Columns>
            </Section>

            <Section title="Thinking" caption="What the models worked through before answering" delay={0.32}>
              <Columns wide>
                <Thinking period={period} known={known} />
                <Levels period={period} />
              </Columns>
            </Section>

            <Section title="Projects and delegation" delay={0.38}>
              <Columns wide>
                <Projects period={period} known={known} tip={showTip} />
                <Delegation period={period} known={known} />
              </Columns>
            </Section>
          </>
        ) : null}
      </div>
      {tip ? (
        <div
          className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11.5px] text-popover-foreground shadow-md"
          style={{ left: tip.x + 12, top: tip.y - 34 }}
        >
          {tip.content}
        </div>
      ) : null}
    </div>
  );
}

function Scanning(props: { progress: { done: number; total: number } | null }) {
  const share = props.progress && props.progress.total ? props.progress.done / props.progress.total : 0;
  return (
    <div className="mx-auto mt-24 max-w-sm text-center">
      <div className="text-sm font-medium">Reading your session logs</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {props.progress?.total ? `${wholeNumber(props.progress.done)} of ${wholeNumber(props.progress.total)} files` : "Starting…"} · only the first visit takes this long
      </div>
      <div className="mt-4 h-1 overflow-hidden rounded bg-foreground/[0.06]">
        <div className="h-full bg-[#6aa7ff]" style={{ width: `${share * 100}%`, transition: "width .3s" }} />
      </div>
    </div>
  );
}
