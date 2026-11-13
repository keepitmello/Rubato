import * as SecureStore from "expo-secure-store";

import type { PushState } from "./sync";

// This phone's relay registration and the grant it gave each Mac (sync.ts). In the Keychain, readable
// after the first unlock so a sync started in the background can use it.
const STATE_KEY = "rubato-push-state";
const storeOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export async function loadPushState(): Promise<PushState | null> {
  const text = await SecureStore.getItemAsync(STATE_KEY, storeOptions);
  if (!text) return null;
  try {
    return JSON.parse(text) as PushState;
  } catch {
    return null;
  }
}

export async function savePushState(state: PushState | null): Promise<void> {
  if (state === null) await SecureStore.deleteItemAsync(STATE_KEY, storeOptions);
  else await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(state), storeOptions);
}
