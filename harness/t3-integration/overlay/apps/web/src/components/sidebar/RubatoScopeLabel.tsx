// The name of the project the list is narrowed to, under the search field.
// With projects off the rail, this line is where the narrowing shows; ✕ goes
// back to all projects.
import { XIcon } from "lucide-react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";

export function RubatoScopeLabel(props: { group: SidebarProjectSnapshot; onClear: () => void }) {
  return (
    <div
      data-rubato-scope-label=""
      className="mx-2 mt-1 flex h-8 items-center gap-2 rounded-md bg-sidebar-accent/70 pr-1 pl-2.5 text-[13px] font-medium text-sidebar-foreground"
    >
      <ProjectFavicon project={props.group} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{props.group.displayName}</span>
      <button
        type="button"
        aria-label="Show all projects"
        title="Show all projects"
        onClick={props.onClear}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
