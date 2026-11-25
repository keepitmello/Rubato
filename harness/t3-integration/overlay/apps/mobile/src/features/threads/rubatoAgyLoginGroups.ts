// Rubato: thread settings list each Antigravity login once, as the desktop's picker does. One T3
// Antigravity instance pairs one agy agent with one Google login, so the main login with Rubato and
// 헬레나 is two instances, and the sub login two more. A login is one section named for the login,
// its agents a choice above its models; only the chosen agent's models show. Search and the
// favorites filter list every agent's models instead, each under "login · agent".
import type { ServerSettings } from "@t3tools/contracts";
import { agyPickerAccounts, type AgyPickerAgent } from "@t3tools/shared/rubatoAgyAccounts";

import type { ProviderGroup } from "../../lib/modelOptions";

export interface AgyLoginChoice {
  /** The login's agents that have models here, the lead first. */
  readonly agents: ReadonlyArray<AgyPickerAgent>;
  /** The agent whose models the section shows. */
  readonly chosen: string;
}

export function agyLoginGroups(input: {
  readonly groups: ReadonlyArray<ProviderGroup>;
  readonly instances: ServerSettings["providerInstances"] | undefined;
  /** The agent picked on each login in this sheet, by the login's railId. */
  readonly picked: ReadonlyMap<string, string>;
  /** The instance of the model the sheet shows as selected: its login opens on that agent. */
  readonly displayedInstanceId: string | undefined;
  readonly narrowed: boolean;
}): {
  readonly groups: ReadonlyArray<ProviderGroup>;
  /** Each merged login's agent choice, by the section's providerKey (the login's railId). */
  readonly choices: ReadonlyMap<string, AgyLoginChoice>;
} {
  const byInstance = new Map(input.groups.map((group) => [group.providerKey, group]));
  const accounts = agyPickerAccounts(
    input.instances as Parameters<typeof agyPickerAccounts>[0],
    input.groups.map((group) => group.providerKey),
  ).filter((account) => account.agents.length > 1);
  const accountOf = new Map(
    accounts.flatMap((account) => account.agents.map((agent) => [agent.instanceId, account] as const)),
  );
  const choices = new Map<string, AgyLoginChoice>();
  if (input.narrowed) {
    const groups = input.groups.map((group) => {
      const account = accountOf.get(group.providerKey);
      const agent = account?.agents.find((candidate) => candidate.instanceId === group.providerKey);
      return account && agent ? { ...group, providerLabel: `${account.label} · ${agent.label}` } : group;
    });
    return { groups, choices };
  }
  const groups = input.groups.flatMap((group): ReadonlyArray<ProviderGroup> => {
    const account = accountOf.get(group.providerKey);
    if (!account) return [group];
    if (choices.has(account.railId)) return [];
    const agents = account.agents.filter((agent) => byInstance.has(agent.instanceId));
    const has = (instanceId: string | undefined) => agents.some((agent) => agent.instanceId === instanceId);
    const picked = input.picked.get(account.railId);
    const chosen = has(picked)
      ? picked!
      : has(input.displayedInstanceId)
        ? input.displayedInstanceId!
        : agents[0]!.instanceId;
    choices.set(account.railId, { agents, chosen });
    return [{ ...byInstance.get(chosen)!, providerKey: account.railId, providerLabel: account.label }];
  });
  return { groups, choices };
}
