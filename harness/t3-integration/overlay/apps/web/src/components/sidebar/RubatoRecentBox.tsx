// The Recent box above the thread list while one project is selected: the
// head of the all-projects inbox (selectRecentThreads), so narrowing the list
// to one project does not hide where the rest of the work moved. It may
// repeat threads the narrowed list also shows; the user chose to keep that.
// Collapsing it leaves one line.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ChevronRightIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import type { ProjectFaviconProject } from "../ProjectFavicon";
import { RubatoThreadLine } from "./RubatoThreadLine";
import { resolveThreadSignal, threadKeyOf } from "./rubatoProjectRail.logic";

const RECENT_EXPANDED_KEY = "rubato:recent-expanded:v1";

export function RubatoRecentBox(props: {
  threads: readonly EnvironmentThreadShell[];
  projectFor: (thread: EnvironmentThreadShell) => ProjectFaviconProject | null;
  activeThreadKey: string | null;
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useLocalStorage(RECENT_EXPANDED_KEY, true, Schema.Boolean);
  const localLastVisitedAt = useUiStateStore((store) => store.threadLastVisitedAtById);
  if (props.threads.length === 0) return null;
  return (
    <section aria-label="Recent threads in all projects" data-rubato-recent="" className="mb-2 flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="group/recent flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-left text-xs font-medium text-sidebar-muted-foreground outline-hidden hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform duration-150", expanded && "rotate-90")}
        />
        <span>Recent</span>
        <span className="font-normal text-sidebar-muted-foreground/70">All projects</span>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-px">
          {props.threads.map((thread) => {
            const key = threadKeyOf(thread);
            return (
              <RubatoThreadLine
                key={key}
                thread={thread}
                project={props.projectFor(thread)}
                signal={resolveThreadSignal(thread, localLastVisitedAt[key])}
                active={props.activeThreadKey === key}
                density="sidebar"
                {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}
              />
            );
          })}
        </div>
      ) : null}
      <div aria-hidden="true" className="mx-2 mt-2 h-px bg-sidebar-border" />
    </section>
  );
}
