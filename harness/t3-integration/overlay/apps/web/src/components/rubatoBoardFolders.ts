import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useProjects } from "../state/entities";

/**
 * The folders the status board reads: every project of this Mac's own server. A team's records
 * live under its lead's folder, which is a project the app lists.
 */
export function useBoardFolders(): { environmentId: ReturnType<typeof usePrimaryEnvironmentId>; folders: string[] } {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const key = useMemo(
    () =>
      [
        ...new Set(
          projects
            .filter((project) => project.environmentId === environmentId && typeof project.workspaceRoot === "string")
            .map((project) => project.workspaceRoot),
        ),
      ]
        .toSorted()
        .join("\n"),
    [environmentId, projects],
  );
  const folders = useMemo(() => (key ? key.split("\n") : []), [key]);
  return { environmentId, folders };
}
