/**
 * Rubato: the composer's model picker shows each Antigravity login once. One T3 Antigravity
 * instance pairs one agy agent with one Google login, so a login with the lead and Helena is two
 * instances; the picker's rail shows the login, and the agents on it are a choice above its
 * models. Logins are grouped as the provider settings group them (shared rubatoAgyAccounts.ts).
 */
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { agyPickerAccounts } from "@t3tools/shared/rubatoAgyAccounts";

import { serverEnvironment } from "~/state/server";

type Instances = Parameters<typeof agyPickerAccounts>[0];

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
