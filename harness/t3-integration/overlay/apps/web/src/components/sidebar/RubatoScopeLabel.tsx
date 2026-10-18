// The project the list is narrowed to, as the title over its threads:
// projects are off the rail, so this is where "you are in rubato-lab" reads.
// It heads the project's section, so dragging it moves that section
// (sidebar/rubatoSidebarBlocks.ts). One step above the thread titles (text-base against their text-sm),
// so it heads the list instead of reading as one more row. The way back to all
// projects is the rail's home and Projects buttons.
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";

export function RubatoScopeLabel(props: { group: SidebarProjectSnapshot }) {
  return (
    <h2
      data-rubato-scope-label=""
      data-rubato-block-handle="threads"
      className="flex min-w-0 items-center gap-2 px-2 pt-2 pb-1 text-base font-semibold text-sidebar-foreground"
    >
      <ProjectFavicon project={props.group} className="size-5 shrink-0" />
      <span className="min-w-0 truncate">{props.group.displayName}</span>
    </h2>
  );
}
