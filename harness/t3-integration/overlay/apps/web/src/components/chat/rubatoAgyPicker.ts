/**
 * Rubato: the composer's model picker shows each Antigravity login once. One T3 Antigravity
 * instance pairs one agy agent with one Google login, so a login with the lead and Helena is two
 * instances; the picker's rail shows the login, and the agents on it are a choice above its
 * models. Logins are grouped as the provider settings group them (RubatoAgyAccounts.logic.ts).
 */
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { serverEnvironment } from "~/state/server";
import { agyAccounts, type AgyInstanceInput } from "../settings/RubatoAgyAccounts.logic";

export interface AgyPickerAgent {
  readonly instanceId: string;
  readonly label: string;
}

export interface AgyPickerAccount {
  /** The instance the rail icon stands for: the login's lead when it has one. */
  readonly railId: string;
  readonly label: string;
  readonly agents: ReadonlyArray<AgyPickerAgent>;
}

const LEAD_AGENT = "rubato-lead";

type Instances = Readonly<Record<string, (AgyInstanceInput & { readonly driver?: unknown }) | undefined>>;

/** The logins among the instances the picker shows, in the picker's order. */
export function agyPickerAccounts(
  instances: Instances | undefined,
  shownIds: ReadonlyArray<string>,
): ReadonlyArray<AgyPickerAccount> {
  const entries = shownIds.flatMap((id) => {
    const instance = instances?.[id];
    return instance?.driver === "antigravity" ? [[id, instance] as const] : [];
  });
  return agyAccounts(entries, new Map()).flatMap((account) => {
    const agents = account.prompts
      .map((prompt) => ({
        instanceId: prompt.instanceId,
        label: prompt.agent === LEAD_AGENT ? "Rubato" : (prompt.agent ?? prompt.name),
        lead: prompt.agent === LEAD_AGENT,
      }))
      // .sort() on a fresh array keeps the settings order among the rest.
      .sort((left, right) => Number(right.lead) - Number(left.lead))
      .map(({ instanceId, label }) => ({ instanceId, label }));
    if (agents.length === 0) return [];
    return [
      {
        railId: agents[0]!.instanceId,
        label: account.isolated ? (account.name ?? "Antigravity") : "Antigravity",
        agents,
      },
    ];
  });
}

const noSettingsAtom = Atom.make<ServerSettings | null>(null);

export function useAgyPickerAccounts(environmentId: EnvironmentId | null, shownIds: ReadonlyArray<string>) {
  const settings = useAtomValue(
    environmentId ? serverEnvironment.settingsValueAtom(environmentId) : noSettingsAtom,
  );
  const key = shownIds.join("\n");
  return useMemo(
    () => agyPickerAccounts(settings?.providerInstances as Instances | undefined, key ? key.split("\n") : []),
    [settings?.providerInstances, key],
  );
}
