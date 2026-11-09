// Removing a project from Rubato in one step, from wherever it is listed:
// Settings > Projects rows and the rail's Projects window. It does what T3's
// own project settings do (ProjectSettingsPanel's removeMembers): one
// confirmation that names the threads it deletes, then every checkout of the
// group goes with its threads, drafts and uploads. Files on disk stay.
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import { uiText } from "../../rubatoI18n";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useThreadShells, waitForProjectRemoval } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useUiStateStore } from "../../uiStateStore";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The confirmation's lines, in the words T3's project settings use. */
export function removeProjectConfirmLines(input: {
  name: string;
  paths: readonly string[];
  threadCount: number;
}): string[] {
  const { name, paths, threadCount } = input;
  return [
    threadCount > 0
      ? threadCount === 1
        ? uiText(`Remove project "${name}" and delete its 1 thread?`)
        : uiText(`Remove project "${name}" and delete its ${threadCount} threads?`)
      : uiText(`Remove project "${name}"?`),
    ...paths.map((path) => uiText(`Path: ${path}`)),
    threadCount > 0
      ? uiText("This permanently clears conversation history for those threads and any archived threads.")
      : uiText("This permanently clears any archived conversation history."),
    uiText("This removes only the project entries, not the files on disk."),
    uiText("This action cannot be undone."),
  ];
}

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: uiText(title),
      description: error instanceof Error ? error.message : uiText("An error occurred."),
    }),
  );
}

/** Asks once, then removes every checkout of the group. Resolves true when it is gone. */
export function useRubatoRemoveProject() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });

  return useCallback(
    async (group: SidebarProjectSnapshot): Promise<boolean> => {
      const members = group.memberProjects;
      const denied = members.find(
        (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
      );
      if (denied) {
        reportFailure(
          "Failed to remove project",
          new Error(
            `This connection cannot change projects in ${denied.environmentLabel ?? "this environment"}.`,
          ),
        );
        return false;
      }
      const api = readLocalApi();
      if (!api) return false;

      const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          removeProjectConfirmLines({
            name: group.displayName,
            paths: members.map((member) => member.workspaceRoot),
            threadCount: projectThreads.length,
          }).join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return false;

      const draftStore = useComposerDraftStore.getState();
      for (const member of members) {
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, force: true },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            reportFailure(`Failed to remove "${member.title}"`, squashAtomCommandFailure(result));
          }
          return false;
        }
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        await waitForProjectRemoval(projectRef);
        releaseProjectDraftUploads(
          projectRef,
          projectThreads
            .filter(
              (thread) =>
                thread.environmentId === member.environmentId && thread.projectId === member.id,
            )
            .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
        );
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (projectDraftThread) draftStore.clearDraftThread(projectDraftThread.draftId);
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      // The sidebar was narrowed to the project that is now gone: back to all projects.
      const ui = useUiStateStore.getState();
      if (ui.sidebarProjectScopeKey === group.projectKey) {
        ui.setSidebarProjectScopeKey(null);
        void navigate({ to: "/", replace: true });
      }
      return true;
    },
    [deleteProject, navigate, threads],
  );
}
