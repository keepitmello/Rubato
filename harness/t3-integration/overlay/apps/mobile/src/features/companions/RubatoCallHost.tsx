// Mounted once at the app's root: wires the system call screen to the call store, keeps an open app
// listening for a companion's ring, and shows the call the phone is on.
import { useEffect } from "react";
import { Alert, AppState } from "react-native";

import { RING_POLL_MS, callActions, pollLiveRings, startCallBridge, useCallView } from "./callStore";
import { CallScreen, RingScreen } from "./CallScreen";
import { useCompanions } from "./companionsStore";
import { copy } from "./copy";

// Before the first render, so an answer on the lock screen that launched the app is not missed.
startCallBridge();

export function RubatoCallHost() {
  const view = useCallView();
  const { companions } = useCompanions();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = (active: boolean) => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (!active) return;
      void pollLiveRings();
      timer = setInterval(() => void pollLiveRings(), RING_POLL_MS);
    };
    run(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", (state) => run(state === "active"));
    return () => {
      subscription.remove();
      if (timer !== null) clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!view.error) return;
    Alert.alert(copy.callFailed, view.error, [{ text: copy.dismiss, onPress: callActions.dismissError }]);
  }, [view.error]);
  const companionOf = (id: string, environmentId: string) =>
    companions.find((item) => item.id === id && item.environmentId === environmentId) ?? null;
  if (view.current)
    return <CallScreen current={view.current} companion={companionOf(view.current.call.companion, view.current.environmentId)} />;
  if (view.ringing) return <RingScreen call={view.ringing} companion={companionOf(view.ringing.companion, view.ringing.environmentId)} />;
  return null;
}
