// Making a new companion from the phone (intent companion-manage). Making one is rare, so it is a
// small "+" beside the gear in the Companions tab's header (mobile/navbar-edits.mjs), not a row in
// the list (user 7ee05fb0). It makes the companion on the Mac and opens its first conversation.
import { CommonActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { companionModelAccounts, type CompanionModelSelection } from "@t3tools/shared/rubatoCompanionModelChoice";
import { useEffect, useRef, useState } from "react";
import { ActionSheetIOS, Alert, Platform } from "react-native";

import { useEnvironments } from "../../state/environments";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { createCompanion } from "./companionsStore";
import { copy } from "./copy";

function choose(title: string, options: readonly string[]): Promise<number | null> {
  return new Promise(resolve => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title, options: [...options, copy.cancel], cancelButtonIndex: options.length },
        index => resolve(index === options.length ? null : index));
    } else {
      Alert.alert(title, undefined, [
        ...options.map((text, index) => ({ text, onPress: () => resolve(index) })),
        { text: copy.cancel, style: "cancel", onPress: () => resolve(null) },
      ], { cancelable: true, onDismiss: () => resolve(null) });
    }
  });
}

async function pickModel(accounts: ReturnType<typeof companionModelAccounts>): Promise<CompanionModelSelection | null | undefined> {
  if (!accounts.length) return null;
  const selected = await choose("Companion model", ["Rubato default", ...accounts.map(account => `Gemini · ${account.label}`)]);
  if (selected === null) return undefined;
  if (selected === 0) return null;
  const account = accounts[selected - 1];
  if (!account) return undefined;
  const models = [...account.models].sort((a, b) => Number(b.slug === account.defaultModel) - Number(a.slug === account.defaultModel));
  const index = await choose(account.label, models.map(model => model.slug === account.defaultModel ? `${model.name} · Default` : model.name));
  const model = index === null ? null : models[index];
  return model ? { instanceId: account.instanceId, model: model.slug } : undefined;
}

/** Which Mac a new companion lives on: the only one, or the one the person picks. */
function pickMac(macs: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>): Promise<EnvironmentId | null> {
  if (macs.length <= 1) return Promise.resolve(macs[0]?.environmentId ?? null);
  return new Promise((resolve) => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: copy.pickMac, options: [...macs.map((mac) => mac.label), copy.cancel], cancelButtonIndex: macs.length },
        (index) => resolve(macs[index]?.environmentId ?? null),
      );
      return;
    }
    Alert.alert(copy.pickMac, undefined, [
      ...macs.map((mac) => ({ text: mac.label, onPress: () => resolve(mac.environmentId) })),
      { text: copy.cancel, style: "cancel" as const, onPress: () => resolve(null) },
    ]);
  });
}

/** `available` while a Mac is paired; `create` ignores presses while one is being made. */
export function useCreateCompanion(): { readonly available: boolean; readonly creating: boolean; readonly label: string; readonly create: () => void } {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const [pickingFor, setPickingFor] = useState<EnvironmentId | null>(null);
  const [creating, setCreating] = useState(false);
  const busy = useRef(false);
  const runtime = useRemoteEnvironmentRuntime(pickingFor);
  const handled = useRef<EnvironmentId | null>(null);
  useEffect(() => {
    if (pickingFor === null || handled.current === pickingFor) return;
    handled.current = pickingFor;
    const config = runtime?.serverConfig;
    void (async () => {
      const selection = await pickModel(companionModelAccounts(config?.providers ?? [], config?.settings.providerInstances));
      if (selection === undefined) return;
      setCreating(true);
      const { id } = await createCompanion(pickingFor, selection);
      navigation.dispatch(CommonActions.navigate("CompanionRoom", { companionId: id, environmentId: pickingFor }));
    })().catch((cause: unknown) => Alert.alert(copy.createFailed, cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        handled.current = null;
        setPickingFor(null);
        busy.current = false;
        setCreating(false);
      });
  }, [pickingFor, runtime, navigation]);
  const create = () => {
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      const environmentId = await pickMac(environments.map((item) => ({ environmentId: item.environmentId, label: item.label })));
      if (environmentId === null) { busy.current = false; return; }
      setPickingFor(environmentId);
    })().catch(() => { busy.current = false; });
  };
  return { available: environments.length > 0, creating, label: creating ? copy.creating : copy.newCompanion, create };
}
