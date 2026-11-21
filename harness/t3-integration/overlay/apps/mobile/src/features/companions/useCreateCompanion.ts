// Making a new companion from the phone (intent companion-manage). Making one is rare, so it is a
// small "+" beside the gear in the Companions tab's header (mobile/navbar-edits.mjs), not a row in
// the list (user 7ee05fb0). It makes the companion on the Mac and opens its first conversation.
import { CommonActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { ActionSheetIOS, Alert, Platform } from "react-native";

import { useEnvironments } from "../../state/environments";
import { createCompanion, useCompanions } from "./companionsStore";
import { copy } from "./copy";

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
  const { paired } = useCompanions();
  const { environments } = useEnvironments();
  const [creating, setCreating] = useState(false);
  const busy = useRef(false);
  const create = () => {
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      const environmentId = await pickMac(environments.map((item) => ({ environmentId: item.environmentId, label: item.label })));
      if (environmentId === null) return;
      setCreating(true);
      await createCompanion(environmentId).then(
        ({ id }) => navigation.dispatch(CommonActions.navigate("CompanionRoom", { companionId: id, environmentId })),
        (cause: unknown) => Alert.alert(copy.createFailed, cause instanceof Error ? cause.message : String(cause)),
      );
    })().finally(() => {
      busy.current = false;
      setCreating(false);
    });
  };
  return { available: paired, creating, label: creating ? copy.creating : copy.newCompanion, create };
}
