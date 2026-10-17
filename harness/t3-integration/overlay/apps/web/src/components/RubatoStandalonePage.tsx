// A Rubato page outside Settings, opened from the rail: the thread sidebar
// stays as it is, and the page takes the main area with the same titlebar
// row Usage and Settings use. The panels it hosts bring their own scroll area.
import type { ReactNode } from "react";

import { isElectron } from "../env";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function RubatoStandalonePage(props: { title: string; children: ReactNode }) {
  useEscapeToGoBack();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="truncate text-sm font-medium">{props.title}</h1>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
      </div>
    </SidebarInset>
  );
}
