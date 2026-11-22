// Mounted once at the app's root: wires the system call screen to the call store, checks for a live
// ring on foreground (or polls gently where PushKit VoIP push is unavailable), and shows the active call.
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Alert, AppState } from "react-native";

import { RubatoCall } from "../../../modules/rubato-call";
import {
  IDLE_RING_POLL_MS,
  callActions,
  hasVoipPush,
  pollLiveRings,
  readCallView,
  startCallBridge,
  useCallView,
  type CallView,
} from "./callStore";
import { CallPill, CallScreen, RingScreen } from "./CallScreen";
import { useCompanions } from "./companionsStore";
import { copy } from "./copy";

// Before the first render, so an answer on the lock screen that launched the app is not missed.
startCallBridge();

/** Mounted only while a call or in-app ring is active, so idle threads never subscribe to companionsStore here. */
function ActiveCallSurface(props: { readonly view: CallView }) {
  const { companions } = useCompanions();
  const companionOf = (id: string, environmentId: string) =>
    companions.find((item) => item.id === id && item.environmentId === environmentId) ?? null;
  if (props.view.current) {
    const companion = companionOf(props.view.current.call.companion, props.view.current.environmentId);
    return props.view.minimized ? (
      <CallPill current={props.view.current} companion={companion} />
    ) : (
      <CallScreen current={props.view.current} companion={companion} />
    );
  }
  if (props.view.ringing) {
    return (
      <RingScreen
        call={props.view.ringing}
        companion={companionOf(props.view.ringing.companion, props.view.ringing.environmentId)}
      />
    );
  }
  return null;
}

export function RubatoCallHost() {
  const view = useCallView();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const sync = (active: boolean, checkNow: boolean) => {
      stop();
      if (!active) return;
      if (checkNow) void pollLiveRings();
      // Real iOS devices receive incoming rings through PushKit VoIP push even in the foreground.
      // Only fall back to periodic polling when no VoIP token is available (simulator, Android).
      if (!hasVoipPush()) {
        timer = setInterval(() => void pollLiveRings(), IDLE_RING_POLL_MS);
      }
    };
    sync(AppState.currentState === "active", true);
    const appSub = AppState.addEventListener("change", (state) => sync(state === "active", state === "active"));
    const voipSub = RubatoCall?.addListener("voipToken", () => sync(AppState.currentState === "active", false));
    return () => {
      appSub.remove();
      voipSub?.remove();
      stop();
    };
  }, []);
  // Opening a notification during a call goes where it points, under the call: the call screen
  // steps aside and the pill brings it back.
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(() => {
      if (readCallView().current) callActions.minimize();
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!view.error) return;
    Alert.alert(copy.callFailed, view.error, [{ text: copy.dismiss, onPress: callActions.dismissError }]);
  }, [view.error]);
  if (!view.current && !view.ringing) return null;
  return <ActiveCallSurface view={view} />;
}
