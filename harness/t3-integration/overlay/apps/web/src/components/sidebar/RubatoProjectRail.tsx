// The rail left of the thread list holds app controls only: home, one Projects
// button, and below a hairline the pages (scheduled tasks, memory, pull
// requests, usage, settings), which replace the sidebar's footer row. Projects
// are never bare icons here; the Projects button opens a window that lists them
// by name and edits the shared list (RubatoProjectPicker.tsx). Choosing a
// project narrows the thread list and leaves the main area alone; a page
// opens in the main area and leaves the list alone. AppSidebarLayout renders
// the rail beside the new sidebar only; the legacy tree keeps its layout.
import {
  BrainIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  FoldersIcon,
  HouseIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { openCommandPalette } from "../../commandPaletteBus";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { rubatoSchedule } from "../../state/rubatoSchedule";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RubatoProjectPicker } from "./RubatoProjectPicker";
import { useRubatoProjectList } from "./rubatoProjectList";
import {
  RUBATO_SIGNAL_DOT,
  RUBATO_SIGNAL_LABEL,
  strongestUrgentSignal,
  type RubatoSignal,
} from "./rubatoProjectRail.logic";

export const RUBATO_RAIL_WIDTH = "52px";

/**
 * The sidebar and the main area now start one rail to the right, so the titlebar
 * inset that clears the window controls shrinks by the rail's width (never below
 * the plain gutter). AppSidebarLayout sets --sidebar-offset-left from md up, where
 * the rail shows; below that the offset falls back to 0 and nothing moves.
 */
export const RUBATO_RAIL_TITLEBAR_STYLE = {
  "--workspace-titlebar-content-left":
    "max(calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap) - var(--sidebar-offset-left, 0px)), 0.75rem)",
} as const;

function SignalDot({ signal, className }: { signal: RubatoSignal | null; className?: string }) {
  if (signal === null) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute size-2 rounded-full ring-2 ring-sidebar",
        RUBATO_SIGNAL_DOT[signal],
        className,
      )}
    />
  );
}

const RAIL_BUTTON_CLASS = cn(
  "group/rail relative flex size-9 shrink-0 items-center justify-center rounded-lg text-sidebar-muted-foreground outline-hidden transition-[background-color,color] duration-150",
  "hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
  "[&_svg:not([class*='size-'])]:size-[18px]",
);
const RAIL_ACTIVE_CLASS =
  "bg-sidebar-accent text-sidebar-foreground before:absolute before:top-2 before:bottom-2 before:-left-[8px] before:w-[3px] before:rounded-r-full before:bg-sidebar-foreground";

function RailButton(props: {
  label: string;
  active?: boolean;
  signal?: RubatoSignal | null;
  onClick: () => void;
  children: ReactNode;
}) {
  const tooltip = props.signal ? `${props.label} · ${RUBATO_SIGNAL_LABEL[props.signal]}` : props.label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={tooltip}
            aria-current={props.active ? "true" : undefined}
            data-rubato-rail-item=""
            onClick={props.onClick}
            className={cn(RAIL_BUTTON_CLASS, props.active && RAIL_ACTIVE_CLASS)}
          >
            {props.children}
            <SignalDot signal={props.signal ?? null} className="top-1 right-1" />
          </button>
        }
      />
      <TooltipPopup side="right">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function RailSeparator() {
  return <div aria-hidden="true" className="my-1 h-px w-6 shrink-0 bg-sidebar-border" />;
}

// A cheap revision poll; the task list is fetched only when it changes.
const SCHEDULE_POLL_MS = 30_000;

function useScheduleSignal(): RubatoSignal | null {
  const [signal, setSignal] = useState<RubatoSignal | null>(null);
  useEffect(() => {
    let cancelled = false;
    let lastRevision: number | null = null;
    const check = async () => {
      try {
        const { revision } = await rubatoSchedule.revision(null);
        if (cancelled || revision === lastRevision) return;
        lastRevision = revision;
        const list = await rubatoSchedule.list(null);
        if (cancelled) return;
        // Only a failure asks for the user; a run in progress needs nothing.
        const failed = list.tasks.some((task) => task.enabled && task.lastRun?.status === "failed");
        setSignal(failed ? "failed" : null);
      } catch {
        // No scheduler on this server: the icon simply carries no dot.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), SCHEDULE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return signal;
}

/** ⌘G (Ctrl+G off the Mac) toggles the project window from anywhere in the app. */
function isProjectWindowShortcut(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "g" &&
    !(event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
  );
}

export function RubatoProjectRail() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { open, setOpen, isMobile } = useSidebar();
  const scopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  const pullRequestsSupported = usePullRequestsSupported();
  const scheduleSignal = useScheduleSignal();
  const { list, signals, lastActivity, remove, add, move } = useRubatoProjectList();
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (isMobile) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isProjectWindowShortcut(event)) return;
      event.preventDefault();
      setPickerOpen((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isMobile]);

  const scopedGroup =
    scopeKey === null
      ? null
      : ([...list.listed, ...list.quiet].find((group) => group.projectKey === scopeKey) ?? null);
  const projectsSignal = strongestUrgentSignal(signals);
  const projectsLabel = scopedGroup
    ? `Projects: ${scopedGroup.displayName} (⌘G)`
    : "Projects (⌘G)";
  const choose = (key: string | null) => {
    setScopeKey(key);
    setPickerOpen(false);
    if (key !== null && !open) void setOpen(true);
  };
  const onPage = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  const onRailPage = ["/scheduled", "/memory", "/pull-requests", "/usage", "/settings"].some(onPage);

  // Phones get the sidebar as a sheet with its own footer; the rail is a desktop column.
  if (isMobile) return null;

  return (
    <nav
      aria-label="App"
      data-rubato-rail=""
      className={cn(
        "relative z-20 flex h-svh w-[52px] shrink-0 flex-col items-center bg-sidebar surface-grain text-sidebar-foreground",
        "pt-[var(--workspace-topbar-height)]",
        // The hairline starts under the titlebar row, so the window controls
        // sit on one unbroken surface across the rail and the sidebar header.
        "after:pointer-events-none after:absolute after:top-[var(--workspace-topbar-height)] after:right-0 after:bottom-0 after:w-px after:bg-sidebar-border",
      )}
    >
      <div className="flex flex-1 flex-col items-center gap-1 px-2 pt-1">
        <RailButton
          label="All projects"
          active={scopeKey === null && !onRailPage}
          onClick={() => {
            setScopeKey(null);
            void navigate({ to: "/" });
          }}
        >
          <HouseIcon />
        </RailButton>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      aria-label={projectsLabel}
                      data-rubato-rail-item=""
                      data-rubato-projects-button=""
                      className={cn(RAIL_BUTTON_CLASS, (pickerOpen || scopedGroup) && RAIL_ACTIVE_CLASS)}
                    >
                      {scopedGroup ? (
                        <ProjectFavicon project={scopedGroup} className="size-5" />
                      ) : (
                        <FoldersIcon />
                      )}
                      <SignalDot signal={projectsSignal} className="top-1 right-1" />
                    </button>
                  }
                />
              }
            />
            <TooltipPopup side="right">{projectsLabel}</TooltipPopup>
          </Tooltip>
          <PopoverPopup side="right" align="start" sideOffset={10} padding="none">
            <RubatoProjectPicker
              list={list}
              signals={signals}
              lastActivity={lastActivity}
              scopeKey={scopeKey}
              onChoose={choose}
              onRemove={remove}
              onAdd={add}
              onMove={move}
              onAddProject={() => {
                setPickerOpen(false);
                openCommandPalette({ open: "add-project" });
              }}
              onProjectSettings={(group) => {
                setPickerOpen(false);
                void navigate({ to: "/projects/$projectKey", params: { projectKey: group.projectKey } });
              }}
            />
          </PopoverPopup>
        </Popover>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1 px-2 pt-2 pb-3">
        <RailSeparator />
        <RailButton
          label="Scheduled tasks"
          active={onPage("/scheduled")}
          signal={scheduleSignal}
          onClick={() => void navigate({ to: "/scheduled" })}
        >
          <CalendarClockIcon />
        </RailButton>
        <RailButton label="Memory" active={onPage("/memory")} onClick={() => void navigate({ to: "/memory" })}>
          <BrainIcon />
        </RailButton>
        {pullRequestsSupported ? (
          <RailButton
            label="Pull requests"
            active={onPage("/pull-requests")}
            onClick={() =>
              void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() })
            }
          >
            <PullRequestGlyph.pullRequest />
          </RailButton>
        ) : null}
        <RailButton label="Usage" active={onPage("/usage")} onClick={() => void navigate({ to: "/usage" })}>
          <ChartNoAxesColumnIcon />
        </RailButton>
        <RailButton label="Settings" active={onPage("/settings")} onClick={() => void navigate({ to: "/settings" })}>
          <SettingsIcon />
        </RailButton>
      </div>
    </nav>
  );
}
