// The rail left of the thread list. The top group is the shared project list
// (rubatoProjectList.ts): a project narrows the thread list and leaves the main
// area alone; the dimmed group below a hairline holds the projects the user
// took off the list. The bottom group opens pages in the main area and leaves
// the thread list alone. AppSidebarLayout renders it beside the new sidebar
// only; the legacy tree keeps its own layout.
import {
  BrainIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  HouseIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { openCommandPalette } from "../../commandPaletteBus";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { rubatoSchedule } from "../../state/rubatoSchedule";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useRubatoProjectList } from "./rubatoProjectList";
import {
  RUBATO_SIGNAL_DOT,
  RUBATO_SIGNAL_LABEL,
  urgentSignal,
  type RubatoSignal,
} from "./rubatoProjectRail.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

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

function RailButton(props: {
  label: string;
  active?: boolean;
  dim?: boolean;
  signal?: RubatoSignal | null;
  onClick: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
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
            onContextMenu={props.onContextMenu}
            className={cn(
              "group/rail relative flex size-9 shrink-0 items-center justify-center rounded-lg text-sidebar-muted-foreground outline-hidden transition-[background-color,color,opacity] duration-150",
              "hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
              "[&_svg:not([class*='size-'])]:size-[18px]",
              props.active &&
                "bg-sidebar-accent text-sidebar-foreground before:absolute before:top-2 before:bottom-2 before:-left-[8px] before:w-[3px] before:rounded-r-full before:bg-sidebar-foreground",
              props.dim && !props.active && "opacity-45 hover:opacity-100",
            )}
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

export function RubatoProjectRail() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { open, setOpen, isMobile } = useSidebar();
  const scopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  const pullRequestsSupported = usePullRequestsSupported();
  const scheduleSignal = useScheduleSignal();
  const { list, signals, remove, add } = useRubatoProjectList();

  const showProject = (key: string) => {
    setScopeKey(scopeKey === key ? null : key);
    if (!open) void setOpen(true);
  };
  const showProjectMenu = async (
    event: MouseEvent<HTMLButtonElement>,
    group: SidebarProjectSnapshot,
    listed: boolean,
  ) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        listed
          ? { id: "remove", label: "Remove from list" }
          : { id: "add", label: "Add to list" },
        { id: "settings", label: "Project settings" },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "remove") remove(group.projectKey);
    else if (clicked === "add") add(group.projectKey);
    else if (clicked === "settings") {
      void navigate({ to: "/projects/$projectKey", params: { projectKey: group.projectKey } });
    }
  };
  const renderProject = (group: SidebarProjectSnapshot, listed: boolean) => (
    <RailButton
      key={group.projectKey}
      label={group.displayName}
      active={scopeKey === group.projectKey}
      dim={!listed}
      signal={urgentSignal(signals.get(group.projectKey))}
      onClick={() => showProject(group.projectKey)}
      onContextMenu={(event) => void showProjectMenu(event, group, listed)}
    >
      {/* Project colors only where the eye is: the selected project and the hovered one. */}
      <span
        className={cn(
          "flex transition-[filter,opacity] duration-150",
          scopeKey !== group.projectKey &&
            "opacity-70 grayscale group-hover/rail:opacity-100 group-hover/rail:grayscale-0",
        )}
      >
        <ProjectFavicon project={group} className="size-5" />
      </span>
    </RailButton>
  );
  const onPage = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

  // Phones get the sidebar as a sheet with its own footer; the rail is a desktop column.
  if (isMobile) return null;

  return (
    <nav
      aria-label="Projects and pages"
      data-rubato-rail=""
      className={cn(
        "relative z-20 flex h-svh w-[52px] shrink-0 flex-col bg-sidebar surface-grain text-sidebar-foreground",
        "pt-[var(--workspace-topbar-height)]",
        // The hairline starts under the titlebar row, so the window controls
        // sit on one unbroken surface across the rail and the sidebar header.
        "after:pointer-events-none after:absolute after:top-[var(--workspace-topbar-height)] after:right-0 after:bottom-0 after:w-px after:bg-sidebar-border",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-2 [scrollbar-width:none]">
        <RailButton
          label="All projects"
          active={scopeKey === null}
          onClick={() => {
            setScopeKey(null);
            void navigate({ to: "/" });
          }}
        >
          <HouseIcon />
        </RailButton>
        {list.listed.length > 0 ? <RailSeparator /> : null}
        {list.listed.map((group) => renderProject(group, true))}
        {list.quiet.length > 0 ? <RailSeparator /> : null}
        {list.quiet.map((group) => renderProject(group, false))}
        <RailButton label="Add project" onClick={() => openCommandPalette({ open: "add-project" })}>
          <PlusIcon />
        </RailButton>
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
