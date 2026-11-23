import { useSyncExternalStore } from "react";
import { getDocumentActivity, subscribeDocumentActivity } from "../lib/documentActivity";

const visible = () => getDocumentActivity().visible;
const off = () => false;
const noWatch = () => () => {};

/** A room in a visible but unfocused window still needs to show changes. Closed details don't. */
export function useRubatoRoomVisible(enabled: boolean) {
  return useSyncExternalStore(enabled ? subscribeDocumentActivity : noWatch, enabled ? visible : off, off);
}
