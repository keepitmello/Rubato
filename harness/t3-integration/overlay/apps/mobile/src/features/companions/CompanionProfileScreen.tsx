// A companion's profile, opened from the face at the top of its room (the accepted mockup's fourth
// phone): its picture, name and what it calls the person. Tapping the picture offers the ways to
// change it: a photo now, the album, a picture from the conversation, or asking the companion to
// draw one (that request goes into the room's field; the drawing comes back as a card to apply).
// Whatever is chosen is placed in a circle (AvatarCropScreen) and the Mac keeps it for every device.
import { CommonActions, useNavigation, useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import { Image } from "expo-image";
import { useState } from "react";
import { ActionSheetIOS, Alert, Modal, Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { chooseFromAlbum, takePhoto, type PickResult } from "./avatarPicture";
import { CompanionAvatar } from "./CompanionAvatar";
import { useCompanion } from "./companionsStore";
import { callsUserLine, copy, sinceLine, withName } from "./copy";
import { requestRoomComposer } from "./roomRequests";

export type CompanionProfileParams = {
  readonly companionId: string;
  readonly environmentId: string;
};

const AVATAR = 132;

export function CompanionProfileScreen(_props: StaticScreenProps<CompanionProfileParams>) {
  const route = useRoute<RouteProp<Record<string, CompanionProfileParams>>>();
  const navigation = useNavigation();
  const { companionId, environmentId } = route.params;
  const { companion } = useCompanion(companionId, environmentId);
  const [viewing, setViewing] = useState(false);
  const title = companion?.title ?? companionId;
  const named = companion?.macTitle != null;

  const crop = (result: PickResult) => {
    if (result === null) return;
    if ("denied" in result) {
      Alert.alert(copy.cameraUnavailable, copy.cameraUnavailableDetail);
      return;
    }
    navigation.dispatch(
      CommonActions.navigate("CompanionAvatarCrop", {
        companionId,
        environmentId,
        uri: result.picture.uri,
        width: String(result.picture.width),
        height: String(result.picture.height),
        depth: "1",
      }),
    );
  };
  const run = (pick: () => Promise<PickResult>) =>
    void pick().then(crop, (error: unknown) =>
      Alert.alert(copy.pictureFailed, error instanceof Error ? error.message : String(error)),
    );
  const options: Array<{ readonly label: string; readonly onPress: () => void }> = [
    { label: copy.takePhoto, onPress: () => run(takePhoto) },
    { label: copy.chooseFromAlbum, onPress: () => run(chooseFromAlbum) },
    ...(companion?.threadId
      ? [{
          label: copy.chooseFromRoom,
          onPress: () =>
            navigation.dispatch(
              CommonActions.navigate("CompanionPictures", { companionId, environmentId, threadId: companion.threadId! }),
            ),
        }]
      : []),
    ...(companion?.threadId
      ? [{
          label: withName(copy.askToDraw, named ? title : copy.newCompanion),
          onPress: () => {
            requestRoomComposer(environmentId, companionId, copy.drawRequest);
            navigation.goBack();
          },
        }]
      : []),
    ...(companion?.art ? [{ label: copy.viewPicture, onPress: () => setViewing(true) }] : []),
  ];
  const openOptions = () => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: copy.changePicture, options: [...options.map((option) => option.label), copy.cancel], cancelButtonIndex: options.length },
        (index) => options[index]?.onPress(),
      );
      return;
    }
    Alert.alert(copy.changePicture, undefined, [
      ...options.map((option) => ({ text: option.label, onPress: option.onPress })),
      { text: copy.cancel, style: "cancel" as const },
    ]);
  };

  const since = companion?.since ? sinceLine(companion.since) : null;
  return (
    <View className="flex-1 items-center bg-screen px-6 pt-10">
      <Pressable accessibilityRole="button" accessibilityLabel={copy.changePicture} onPress={openOptions} className="active:opacity-80">
        <CompanionAvatar art={companion?.art ?? null} title={named ? title : "?"} size={AVATAR} />
        <View
          className="absolute items-center justify-center rounded-full border-[3px] border-screen bg-primary"
          style={{ right: -2, bottom: -2, width: 38, height: 38 }}
        >
          <SymbolView name="camera" size={16} tintColorClassName="accent-primary-foreground" />
        </View>
      </Pressable>
      <Text numberOfLines={1} className="mt-4 font-t3-bold text-[24px] text-foreground">
        {title}
      </Text>
      {companion?.callsUser ? (
        <Text className="mt-1 text-[15px] text-foreground-muted">{callsUserLine(companion.callsUser)}</Text>
      ) : null}
      {since ? <Text className="mt-0.5 text-[13px] text-foreground-muted">{since}</Text> : null}
      <Pressable accessibilityRole="button" onPress={openOptions} className="mt-6 rounded-full border border-border px-5 py-2.5 active:opacity-70">
        <Text className="font-t3-bold text-[15px] text-foreground">{copy.changePicture}</Text>
      </Pressable>
      <Modal visible={viewing} transparent animationType="fade" onRequestClose={() => setViewing(false)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.dismiss}
          onPress={() => setViewing(false)}
          className="flex-1 items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.92)" }}
        >
          {companion?.art ? (
            <Image source={{ uri: companion.art }} contentFit="contain" style={{ width: "92%", aspectRatio: 1 }} accessibilityIgnoresInvertColors />
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}
