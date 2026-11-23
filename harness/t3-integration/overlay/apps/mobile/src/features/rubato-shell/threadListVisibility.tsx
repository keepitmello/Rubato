import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useEffect, useMemo, useState } from "react";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppActive } from "../../lib/appState";
import { useCompanions } from "../companions/companionsStore";
import { postRubato } from "../companions/rubatoHttp";
import { startRoomPoll } from "../companions/roomPoll";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { isCompanionLaunchThread, projectKey, toggleProjectVisibility, visibleProjects } from "./threadListVisibilityModel";

const NO_PROJECTS: readonly string[] = [];
const NO_LAUNCHES: ReadonlySet<string> = new Set();
type ProjectRef = Parameters<typeof projectKey>[0];

function useVisibilityPreferences() {
  const read = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences);
  const loaded = AsyncResult.isSuccess(read);
  return { preferences: loaded ? read.value : null, save, loaded };
}

export function ThreadListVisibilitySettings() {
  const gt = useGT();
  const { preferences, save, loaded } = useVisibilityPreferences();
  return (
    <SettingsSection title={gt("List display")}>
      <SettingsSwitchRow
        icon="text.bubble"
        label={gt("Show companion-created threads")}
        subtitle={gt("When hidden, you can still open them from a companion chat. Notifications are separate.")}
        value={preferences?.rubatoShowCompanionLeads === true}
        disabled={!loaded}
        onValueChange={(value) => void save({ transform: () => ({ rubatoShowCompanionLeads: value }) })}
      />
    </SettingsSection>
  );
}

function useCompanionLaunchSessions(visible: boolean) {
  const active = useAppActive();
  const { companions } = useCompanions(visible && active);
  const [index, setIndex] = useState<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map());
  const sources = JSON.stringify(companions.flatMap(({ id, environmentId, sessionId }) => sessionId ? [[environmentId, id, sessionId]] : []));
  useEffect(() => {
    if (!visible || !active) return;
    const entries = JSON.parse(sources) as readonly (readonly [EnvironmentId, string, string])[];
    if (!entries.length) return;
    const revisions = new Map<string, string>();
    return startRoomPoll(15_000, async (signal) => {
      const environmentIds = [...new Set(entries.map(([id]) => id))];
      const durable = await Promise.allSettled(environmentIds.map(async (environmentId) => {
        const answer = await postRubato<{ sessionIds: readonly string[] | null }>(
          environmentId, "/rubato/companion", "lead-sessions", {}, { timeoutMs: 4_000, signal },
        );
        return [environmentId, answer.sessionIds ?? []] as const;
      }));
      if (signal.aborted) return false;
      // Pairing with an older Mac still works: its companion rooms already expose launch records.
      const results = await Promise.allSettled(entries.map(async ([environmentId, companionId]) => {
        const key = JSON.stringify([environmentId, companionId]);
        const answer = await postRubato<{
          revision?: string; unchanged?: true; workSessionIds?: readonly string[];
          spans?: readonly ({ launches?: readonly { sessionId: string | null }[] } | null)[];
        }>(
          environmentId, "/rubato/companion", "inner",
          { companionId, boundaries: [], versioned: true, view: "work-ids", revision: revisions.get(key) },
          { timeoutMs: 4_000, signal },
        );
        if (answer.revision && !signal.aborted) revisions.set(key, answer.revision);
        return [environmentId, answer.workSessionIds ??
          (answer.spans?.[0]?.launches ?? []).flatMap(({ sessionId }) => sessionId ? [sessionId] : [])] as const;
      }));
      if (signal.aborted) return false;
      setIndex((previous) => {
        const next = new Map(previous);
        for (const result of [...durable, ...results]) {
          if (result.status !== "fulfilled") continue;
          const [environmentId, ids] = result.value;
          const existing = next.get(environmentId) ?? NO_LAUNCHES;
          if (ids.some((id) => !existing.has(id))) next.set(environmentId, new Set([...existing, ...ids]));
        }
        return next.size !== previous.size || [...next].some(([id, ids]) => previous.get(id) !== ids) ? next : previous;
      });
    });
  }, [active, sources, visible]);
  return index;
}

export function useThreadListVisibility(visible: boolean) {
  const { preferences, save, loaded } = useVisibilityPreferences();
  const showLeads = preferences?.rubatoShowCompanionLeads === true;
  const launches = useCompanionLaunchSessions(visible && !showLeads);
  const keys = preferences?.rubatoHiddenProjectKeys ?? NO_PROJECTS;
  const hidden = useMemo(() => new Set(keys), [keys]);
  return {
    hidden,
    toggle(keys: readonly string[]) {
      if (loaded) void save({ transform: (current) => ({
        rubatoHiddenProjectKeys: toggleProjectVisibility(current.rubatoHiddenProjectKeys ?? NO_PROJECTS, keys),
      }) });
    },
    reset() {
      if (loaded) void save({ transform: () => ({ rubatoHiddenProjectKeys: NO_PROJECTS }) });
    },
    filterProjects<T extends ProjectRef>(items: readonly T[]) {
      return visibleProjects(items, hidden);
    },
    filterThreads<T extends ProjectRef & { readonly id: string }>(items: readonly T[]) {
      const projects = visibleProjects(items, hidden);
      return showLeads || launches.size === 0 ? projects : projects.filter((thread) =>
        !isCompanionLaunchThread(thread.id, launches.get(thread.environmentId) ?? NO_LAUNCHES));
    },
  };
}

export function useProjectVisibilityMenu<T extends { key: string; title: string; projectRefs: readonly ProjectRef[] }>(
  scopes: readonly T[], visibility: ReturnType<typeof useThreadListVisibility>, selectProject: (key: string | null) => void,
) {
  const gt = useGT();
  const active = scopes.some((scope) => scope.projectRefs.some((ref) => visibility.hidden.has(projectKey(ref))));
  const visibleScopes = scopes.filter((scope) => scope.projectRefs.some((ref) => !visibility.hidden.has(projectKey(ref))));
  const visibleKeys = new Set(visibleScopes.map((scope) => scope.key));
  const items: AppBarMenuItem[] = scopes.length === 0 ? [] : [{
    id: "rubato-project-visibility",
    title: gt("Projects shown in list"),
    items: [
      ...scopes.map((scope) => ({
        id: `rubato-project-visibility:${scope.key}`,
        title: scope.title,
        selected: visibleKeys.has(scope.key),
        onPress: () => {
          visibility.toggle(scope.projectRefs.map(projectKey));
          if (visibleKeys.has(scope.key)) selectProject(null);
        },
      })),
      ...(active ? [{ id: "rubato-project-visibility:reset", title: gt("Show all projects"), onPress: visibility.reset }] : []),
    ],
  }];
  return { items, active, visibleScopes, visibleKeys };
}

export function ProjectVisibilityPill({ items, active }: { items: readonly AppBarMenuItem[]; active: boolean }) {
  const gt = useGT();
  const group = items[0];
  if (!group || !("items" in group)) return null;
  const actions = group.items.flatMap((item) => "onPress" in item ? [{
    id: item.id, title: item.title, ...(item.selected === undefined ? {} : { state: item.selected ? "on" as const : "off" as const }),
  }] : []);
  return (
    <ListFilterMenu label={gt("Projects shown")} accessibilityLabel={gt("Projects shown in list")} active={active}
      actions={actions} onSelect={(id) => {
        const item = group.items.find((candidate) => candidate.id === id);
        if (item && "onPress" in item) item.onPress();
      }} />
  );
}
