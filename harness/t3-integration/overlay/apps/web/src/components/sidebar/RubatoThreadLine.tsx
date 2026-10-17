// One thread on one line: the Recent box and the home list use it. The
// sidebar's own rows are three-line cards; five of them would turn a glance
// into a scroll, so these keep only the title and the time, or a word when the
// thread asks the user to act.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useRouter } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { RUBATO_SIGNAL_LABEL, urgentSignal, type RubatoSignal } from "./rubatoProjectRail.logic";

const SIGNAL_TEXT: Record<RubatoSignal, string> = {
  attention: "text-warning-foreground",
  failed: "text-error",
  done: "text-success",
  working: "text-info",
};

export function rubatoThreadTimeLabel(
  thread: Pick<EnvironmentThreadShell, "latestUserMessageAt" | "updatedAt">,
): string {
  const label = formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

export function RubatoThreadLine(props: {
  thread: EnvironmentThreadShell;
  project: ProjectFaviconProject | null;
  signal: RubatoSignal | null;
  active?: boolean;
  /** Row height and inset: the sidebar's tighter rows or the home list's. */
  density: "sidebar" | "home";
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const { thread } = props;
  // A word only for what asks the user to act; everything else shows its time.
  const signal = urgentSignal(props.signal);
  return (
    <button
      type="button"
      data-rubato-thread-line=""
      aria-current={props.active ? "page" : undefined}
      title={thread.title}
      onClick={() => {
        props.onNavigate?.();
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
        });
      }}
      className={cn(
        "group/line flex w-full min-w-0 items-center gap-2 rounded-[7px] text-left outline-hidden",
        "focus-visible:ring-2 focus-visible:ring-ring",
        props.density === "sidebar"
          ? "h-7 px-2 text-[13px] text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          : "h-8 px-2.5 text-[13px] text-foreground/85 hover:bg-accent hover:text-foreground",
        props.active &&
          (props.density === "sidebar"
            ? "bg-sidebar-accent text-sidebar-foreground"
            : "bg-accent text-foreground"),
      )}
    >
      {props.project ? (
        <ProjectFavicon project={props.project} className="size-4 shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      {signal ? (
        <span className={cn("shrink-0 text-[11px] font-medium", SIGNAL_TEXT[signal])}>
          {RUBATO_SIGNAL_LABEL[signal]}
        </span>
      ) : (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80">
          {rubatoThreadTimeLabel(thread)}
        </span>
      )}
    </button>
  );
}
