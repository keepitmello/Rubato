// The tab root's horizontal swipe (tabSwipe.ts). It lives only on the root screen, so a pushed
// screen (a room, a thread) keeps the iOS back swipe to itself.
import { useCallback, useMemo, type ReactNode } from "react";
import { Keyboard } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import type { WorkspaceTab } from "../workspace/workspace-tabs-state";
import { TAB_SWIPE, tabSwipeFollow, tabSwipeNeighbors, tabSwipeStep } from "./tabSwipe";

const SETTLE = { duration: 180 };

export function WorkspaceTabSwipe(props: {
  readonly tab: WorkspaceTab;
  /** Off where the tab bar is not the phone's (iPad sidebar) and while a list is searching. */
  readonly enabled: boolean;
  readonly onSelect: (tab: WorkspaceTab) => void;
  readonly children: ReactNode;
}) {
  const { tab, enabled, onSelect } = props;
  const { previous, next } = tabSwipeNeighbors(tab);
  const lean = useSharedValue(0);
  const select = useCallback(
    (step: number) => {
      const target = step > 0 ? next : previous;
      if (target === null) return;
      Keyboard.dismiss();
      onSelect(target);
    },
    [next, previous, onSelect],
  );
  const gesture = useMemo(() => {
    const canPrevious = previous !== null;
    const canNext = next !== null;
    const pan = Gesture.Pan()
      .enabled(enabled && (canPrevious || canNext))
      .failOffsetY([-TAB_SWIPE.failVertical, TAB_SWIPE.failVertical]);
    if (canPrevious && canNext) pan.activeOffsetX([-TAB_SWIPE.activate, TAB_SWIPE.activate]);
    else if (canNext) pan.activeOffsetX(-TAB_SWIPE.activate).failOffsetX(TAB_SWIPE.failAgainst);
    else pan.activeOffsetX(TAB_SWIPE.activate).failOffsetX(-TAB_SWIPE.failAgainst);
    // The chain is split above, so the worklet plugin may not see these as gesture callbacks.
    return pan
      .onUpdate((event) => {
        "worklet";
        lean.set(tabSwipeFollow(event.translationX, canPrevious, canNext));
      })
      .onEnd((event) => {
        "worklet";
        const step = tabSwipeStep(event.translationX, event.velocityX, canPrevious, canNext);
        if (step !== 0) runOnJS(select)(step);
      })
      .onFinalize(() => {
        "worklet";
        lean.set(withTiming(0, SETTLE));
      });
  }, [enabled, previous, next, lean, select]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: lean.get() }] }));
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ flex: 1 }, style]}>{props.children}</Animated.View>
    </GestureDetector>
  );
}
