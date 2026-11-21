// Placing a new picture for a companion in a circle (intent companion-manage: "cropped round, shown
// the same on both"): drag to move, pinch to zoom, and the square around the circle goes to the
// Mac, which keeps it for the desktop and every phone. The picture always covers the circle
// (pictureModel.ts clampOffset); it springs back when let go past an edge.
import { StackActions, useNavigation, useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { renderAvatar } from "./avatarPicture";
import { setCompanionAvatar } from "./companionsStore";
import { copy } from "./copy";
import { clampOffset, clampZoom, coverScale, cropRect } from "./pictureModel";

export type CompanionAvatarCropParams = {
  readonly companionId: string;
  readonly environmentId: string;
  /** The prepared picture (avatarPicture.ts preparePicture): an upright JPEG file and its size. */
  readonly uri: string;
  readonly width: string;
  readonly height: string;
  /** How many screens to close when done: the crop, and the picture list it came from. */
  readonly depth?: string;
};

const SPRING = { damping: 22, stiffness: 240 };

export function AvatarCropScreen(_props: StaticScreenProps<CompanionAvatarCropParams>) {
  const route = useRoute<RouteProp<Record<string, CompanionAvatarCropParams>>>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const params = route.params;
  const image = { width: Number(params.width) || 1, height: Number(params.height) || 1 };
  const diameter = Math.min(screenWidth - 48, 360);
  const base = coverScale(image, diameter);
  const zoom = useSharedValue(1);
  const startZoom = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const [saving, setSaving] = useState(false);

  const settle = () => {
    "worklet";
    const z = clampZoom(zoom.value);
    const placed = clampOffset(image, diameter, z, { x: x.value, y: y.value });
    zoom.value = withSpring(z, SPRING);
    x.value = withSpring(placed.x, SPRING);
    y.value = withSpring(placed.y, SPRING);
  };
  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((event) => {
      x.value = startX.value + event.translationX;
      y.value = startY.value + event.translationY;
    })
    .onEnd(settle);
  const pinch = Gesture.Pinch()
    .onStart(() => {
      startZoom.value = zoom.value;
    })
    .onUpdate((event) => {
      zoom.value = Math.max(0.6, startZoom.value * event.scale);
    })
    .onEnd(settle);
  const gesture = Gesture.Simultaneous(pan, pinch);
  const placed = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: zoom.value }],
  }));

  const close = () => navigation.dispatch(StackActions.pop(Number(params.depth) || 1));
  const choose = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const crop = cropRect(image, diameter, zoom.value, { x: x.value, y: y.value });
      const dataUrl = await renderAvatar({ uri: params.uri, ...image }, crop);
      await setCompanionAvatar({ environmentId: params.environmentId as EnvironmentId, id: params.companionId }, dataUrl);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      close();
    } catch (error) {
      setSaving(false);
      Alert.alert(copy.pictureFailed, error instanceof Error ? error.message : String(error));
    }
  };

  // The dim outside the circle: the whole screen less the circle, filled even-odd. (A ring drawn
  // as a screen-wide border did not render on iOS.)
  const r = diameter / 2;
  const cx = screenWidth / 2;
  const cy = screenHeight / 2;
  const dim = `M0 0H${screenWidth}V${screenHeight}H0Z M${cx - r} ${cy}a${r} ${r} 0 1 0 ${diameter} 0a${r} ${r} 0 1 0 ${-diameter} 0Z`;
  return (
    <View className="flex-1 overflow-hidden" style={{ backgroundColor: "#000" }}>
      <GestureDetector gesture={gesture}>
        <View className="flex-1 items-center justify-center">
          <Animated.View style={[{ width: image.width * base, height: image.height * base }, placed]}>
            <Image source={{ uri: params.uri }} style={{ width: "100%", height: "100%" }} contentFit="fill" accessibilityIgnoresInvertColors />
          </Animated.View>
          <Svg pointerEvents="none" width={screenWidth} height={screenHeight} style={{ position: "absolute", left: 0, top: 0 }}>
            <Path d={dim} fill="rgba(0,0,0,0.62)" fillRule="evenodd" />
          </Svg>
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              width: diameter,
              height: diameter,
              borderRadius: diameter / 2,
              borderWidth: 1.5,
              borderColor: "rgba(255,255,255,0.85)",
            }}
          />
        </View>
      </GestureDetector>
      <View pointerEvents="none" style={{ position: "absolute", top: insets.top + 18, left: 0, right: 0 }}>
        <Text className="text-center font-t3-bold text-[17px]" style={{ color: "#fff" }}>
          {copy.cropTitle}
        </Text>
      </View>
      <View
        className="flex-row items-center justify-between px-6"
        style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 16 }}
      >
        <Pressable accessibilityRole="button" onPress={close} disabled={saving} hitSlop={10} className="py-3 active:opacity-60">
          <Text className="text-[17px]" style={{ color: "#fff" }}>
            {copy.cancel}
          </Text>
        </Pressable>
        {saving ? (
          <View className="flex-row items-center gap-2 py-3">
            <ActivityIndicator color="#fff" />
            <Text className="text-[17px]" style={{ color: "#fff" }}>
              {copy.savingPicture}
            </Text>
          </View>
        ) : (
          <Pressable accessibilityRole="button" onPress={() => void choose()} hitSlop={10} className="py-3 active:opacity-60">
            <Text className="font-t3-bold text-[17px]" style={{ color: "#fff" }}>
              {copy.choose}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
