// The Recent box above the thread list while one project is selected: the
// head of the all-projects inbox (selectRecentThreads), so narrowing the list
// to one project does not hide where the rest of the work moved. It may
// repeat threads the narrowed list also shows; the user chose to keep that.
// Collapsing it leaves one line.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useUiStateStore } from "../../uiStateStore";
import type { ProjectFaviconProject } from "../ProjectFavicon";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
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
    <section aria-label="Recent threads in all projects" data-rubato-recent="" className="mx-0.5 mb-1 flex flex-col">
      {/* The same header as the sidebar's own shelves (Settled, Snoozed). */}
      <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
        Recent
      </CollapsibleSectionHeader>
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
    </section>
  );
}
