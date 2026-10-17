// Rubato (section-scale-edits.mjs): Settings > Appearance > Section sizes. A
// slider per part and a small window drawn with the same zoom the app uses,
// so the preview shows what the sizes look like together before leaving
// Settings. The sliders and the hover shortcut write the same saved scales.
import {
  BrainIcon,
  CalendarClockIcon,
  FoldersIcon,
  HouseIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { cn, isMacPlatform } from "../../lib/utils";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSectionScales } from "../sidebar/RubatoSectionScale";
import {
  DEFAULT_SECTION_SCALES,
  SECTION_PARTS,
  SECTION_SCALE_DEFAULT,
  SECTION_SCALE_MAX,
  SECTION_SCALE_MIN,
  SECTION_SCALE_STEP,
  sectionScaleVariable,
  setSectionScale,
  type SectionPartId,
} from "../sidebar/rubatoSectionScale.logic";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PART_DESCRIPTIONS: Record<SectionPartId, string> = {
  rail: "Home, Projects and the page buttons left of the thread list.",
  title: "The project name above the list while one project is chosen.",
  recent: "The newest threads across projects, above a chosen project's list.",
  cards: "The thread list in the sidebar.",
  homeTabs: "The project tabs under the new-thread composer.",
  homeThreads: "The chosen project's threads under the tabs.",
  messages: "The conversation. Its column stays as wide as the composer.",
};

/** The zoom a preview part takes from the live setting. */
function zoomOf(part: SectionPartId): CSSProperties {
  return { zoom: `var(${sectionScaleVariable(part)}, 1)` };
}

function PreviewLine(props: { title: string; time: string; tone?: "sidebar" | "home" }) {
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-md text-sm",
        props.tone === "home" ? "px-2.5 text-foreground/85" : "px-2 text-sidebar-foreground/85",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80">{props.time}</span>
    </div>
  );
}

function PreviewCard(props: { title: string; detail: string; active?: boolean }) {
  return (
    <div className="py-0.5">
      <div
        style={zoomOf("cards")}
        className={cn(
          "flex h-[4.875rem] flex-col justify-center gap-1 rounded-lg px-2.5",
          props.active ? "bg-sidebar-accent" : null,
        )}
      >
        <span className="truncate text-sm font-medium text-foreground/90">{props.title}</span>
        <span className="truncate text-xs text-sidebar-muted-foreground">{props.detail}</span>
      </div>
    </div>
  );
}

function PreviewRailButton(props: { children: ReactNode; active?: boolean }) {
  return (
    <span
      className={cn(
        "flex size-9 items-center justify-center rounded-lg text-sidebar-muted-foreground [&_svg]:size-[18px]",
        props.active && "bg-sidebar-accent text-sidebar-foreground",
      )}
    >
      {props.children}
    </span>
  );
}

/** A small window: the rail, a narrowed sidebar, the home row and a conversation. */
function SectionSizesPreview() {
  return (
    <div
      aria-hidden="true"
      data-rubato-section-preview=""
      className="pointer-events-none overflow-hidden rounded-lg border border-border/70 select-none"
    >
      <div className="flex h-[460px] bg-background" style={{ zoom: 0.7 }}>
        <div
          className="flex shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar pt-3"
          style={{ width: `calc(52px * var(${sectionScaleVariable("rail")}, 1))` }}
        >
          <div className="flex flex-col items-center gap-1 px-2" style={zoomOf("rail")}>
            <PreviewRailButton>
              <HouseIcon />
            </PreviewRailButton>
            <PreviewRailButton active>
              <FoldersIcon />
            </PreviewRailButton>
            <span className="my-1 h-px w-6 bg-sidebar-border" />
            <PreviewRailButton>
              <CalendarClockIcon />
            </PreviewRailButton>
            <PreviewRailButton>
              <BrainIcon />
            </PreviewRailButton>
            <PreviewRailButton>
              <SettingsIcon />
            </PreviewRailButton>
          </div>
        </div>
        <div className="flex w-[250px] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar px-2 pt-2 text-sidebar-foreground">
          <h3
            className="flex min-w-0 items-center gap-2 px-2 pt-2 pb-1 text-base font-semibold"
            style={zoomOf("title")}
          >
            <span className="size-5 shrink-0 rounded-sm bg-primary/70" />
            <span className="truncate">rubato-lab</span>
          </h3>
          <div className="mx-0.5 mb-1 flex flex-col" style={zoomOf("recent")}>
            <CollapsibleSectionHeader expanded tabIndex={-1}>
              Recent
            </CollapsibleSectionHeader>
            <PreviewLine title="Release notes draft" time="2m" />
            <PreviewLine title="Fix flaky upload test" time="1h" />
          </div>
          <PreviewCard title="Section sizes for the sidebar" detail="Working · 3m" active />
          <PreviewCard title="Home tabs paging dot" detail="Done · 25m" />
          <PreviewCard title="Rail tooltip copy" detail="Yesterday" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden px-6 pt-5">
            <div className="flex flex-col gap-3" style={zoomOf("messages")}>
              <div className="ml-auto max-w-[75%] rounded-2xl bg-secondary px-3.5 py-2 text-sm text-foreground">
                Can Recent be a little larger?
              </div>
              <p className="text-sm leading-relaxed text-foreground/90">
                Hover it and press Ctrl +. Each part keeps its own size.
              </p>
            </div>
          </div>
          <div className="px-6 pb-5">
            <div className="mb-4 flex h-16 items-start rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              Ask anything…
            </div>
            <div className="flex h-8 items-center gap-0.5" style={zoomOf("homeTabs")}>
              <span className="flex h-8 items-center rounded-md bg-accent px-2.5 text-sm text-foreground">
                rubato-lab
              </span>
              <span className="flex h-8 items-center px-2.5 text-sm text-muted-foreground">
                website
              </span>
              <span className="flex h-8 items-center px-2.5 text-sm text-muted-foreground">
                notes
              </span>
              <span className="ml-auto flex size-8 items-center justify-center text-muted-foreground">
                <PlusIcon className="size-4" />
              </span>
            </div>
            <div className="mt-1.5 mb-1 h-px bg-border" />
            <div className="grid grid-cols-2 gap-x-5" style={zoomOf("homeThreads")}>
              <PreviewLine tone="home" title="Section sizes for the sidebar" time="3m" />
              <PreviewLine tone="home" title="Rail tooltip copy" time="1d" />
              <PreviewLine tone="home" title="Home tabs paging dot" time="25m" />
              <PreviewLine tone="home" title="Recent box spacing" time="2d" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RubatoSectionSizesSection() {
  const [scales, setScales] = useSectionScales();
  const changed = SECTION_PARTS.some((part) => scales[part.id] !== SECTION_SCALE_DEFAULT);
  return (
    <SettingsSection
      id={searchableSetting("section-sizes").id}
      title="Section sizes"
      headerAction={
        changed ? (
          <SettingResetButton
            label="section sizes"
            onClick={() => setScales(DEFAULT_SECTION_SCALES)}
          />
        ) : null
      }
    >
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          Each part grows on top of the interface font size. Hover a part and press{" "}
          {isMacPlatform(navigator.platform) ? "Ctrl + / Ctrl − / Ctrl 0" : "Ctrl+Alt + / − / 0"} to
          change just that part.
        </p>
        <SectionSizesPreview />
      </div>
      {SECTION_PARTS.map((part) => {
        const value = scales[part.id];
        const ratio = (value - SECTION_SCALE_MIN) / (SECTION_SCALE_MAX - SECTION_SCALE_MIN);
        const inputId = `section-size-${part.id}`;
        return (
          <SettingsRow
            key={part.id}
            title={part.label}
            description={PART_DESCRIPTIONS[part.id]}
            control={
              <div className="flex w-full items-center gap-3 sm:w-56">
                <output
                  htmlFor={inputId}
                  className="min-w-14 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                >
                  {value}%
                </output>
                <input
                  id={inputId}
                  type="range"
                  aria-label={`${part.label} size`}
                  className="settings-slider min-w-0 flex-1"
                  min={SECTION_SCALE_MIN}
                  max={SECTION_SCALE_MAX}
                  step={SECTION_SCALE_STEP}
                  value={value}
                  style={
                    {
                      "--settings-slider-progress": `${ratio * 100}%`,
                      "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
                    } as CSSProperties
                  }
                  onChange={(event) =>
                    setScales(setSectionScale(scales, part.id, Number(event.currentTarget.value)))
                  }
                />
              </div>
            }
            resetAction={
              value !== SECTION_SCALE_DEFAULT ? (
                <SettingResetButton
                  label={part.label.toLowerCase()}
                  onClick={() => setScales(setSectionScale(scales, part.id, SECTION_SCALE_DEFAULT))}
                />
              ) : null
            }
          />
        );
      })}
    </SettingsSection>
  );
}
