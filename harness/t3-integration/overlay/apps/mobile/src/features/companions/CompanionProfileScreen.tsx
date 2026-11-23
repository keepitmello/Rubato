// A companion's profile, opened from the face at the top of its room (the accepted mockup's fourth
// phone): its picture, name and what it calls the person. Tapping the picture offers the ways to
// change it: a photo now, the album, a picture from the conversation, or asking the companion to
// draw one (that request goes into the room's field; the drawing comes back as a card to apply).
// Whatever is chosen is placed in a circle (AvatarCropScreen) and the Mac keeps it for every device.
import { CommonActions, useNavigation, useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { CompanionModelSelection } from "@t3tools/shared/rubatoCompanionModelChoice";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useMemo, useRef, useState } from "react";
import { ActionSheetIOS, Alert, Modal, Platform, Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useQuietThreadShell } from "../../state/entities";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { chooseFromAlbum, takePhoto, type PickResult } from "./avatarPicture";
import { CompanionAvatar } from "./CompanionAvatar";
import { useCompanion } from "./companionsStore";
import { copy, phoneLocale } from "./copy";
import { callsUserLine, sinceLine, withName } from "./profileLines";
import { roomModelMenu, roomModelRequest } from "./roomModelChoice";
import { requestRoomComposer } from "./roomRequests";
import { postRubato } from "./rubatoHttp";

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
  const [modelPage, setModelPage] = useState<readonly string[] | null>(null);
  const [applied, setApplied] = useState<{ threadId: ThreadId; selection: CompanionModelSelection } | null>(null);
  const [switching, setSwitching] = useState(false);
  const picking = useRef(false);
  const title = companion?.title ?? companionId;
  const named = companion?.macTitle != null;
  const threadId = companion?.threadId;
  const envId = environmentId as EnvironmentId;
  const ref = useMemo(() => threadId ? { environmentId: envId, threadId: threadId as ThreadId } : null, [envId, threadId]);
  const thread = useQuietThreadShell(ref);
  const config = useRemoteEnvironmentRuntime(envId)?.serverConfig;
  const selectModel = async (selection: CompanionModelSelection) => {
    if (!ref || picking.current) return;
    picking.current = true;
    setSwitching(true);
    try {
      await postRubato(envId, "/rubato/companion-room", "model", roomModelRequest(ref.threadId, selection), { timeoutMs: 30_000 });
      setApplied({ threadId: ref.threadId, selection });
      setModelPage(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert(copy.modelFailed, error instanceof Error ? error.message : String(error));
    } finally {
      picking.current = false;
      setSwitching(false);
    }
  };
  const menu = ref && thread && config ? roomModelMenu({
    providers: config.providers,
    instances: config.settings.providerInstances,
    owner: thread.modelSelection.instanceId,
    applied: applied?.threadId === ref.threadId ? applied.selection : null,
    busy: switching,
    labels: { menu: copy.changeModel, rubato: copy.modelRubato, gemini: account => withName(copy.modelGemini, account), defaultModel: copy.modelDefault },
    onPick: selection => void selectModel(selection),
  }) : null;

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

  const since = companion?.since ? sinceLine(companion.since, phoneLocale()) : null;
  if (modelPage !== null && menu) {
    let { items, title: heading } = menu;
    for (const id of modelPage) {
      const group = items.find(item => item.id === id && "items" in item);
      if (!group || !("items" in group)) break;
      items = group.items;
      heading = group.title ?? heading;
    }
    return (
      <ScrollView className="flex-1 bg-screen px-6 pt-8" key={modelPage.join("/")}>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: switching }} disabled={switching}
          onPress={() => setModelPage(modelPage.length ? modelPage.slice(0, -1) : null)} className="min-h-11 justify-center">
          <Text className="text-primary">{copy.back}</Text>
        </Pressable>
        <Text accessibilityRole="header" className="mb-2 font-t3-bold text-xl text-foreground">{heading}</Text>
        {items.map(item => {
          const group = "items" in item;
          const disabled = switching || (!group && item.disabled === true);
          return (
            <Pressable key={item.id} accessibilityRole="button"
              accessibilityState={{ disabled, ...(!group ? { selected: item.selected } : {}) }}
              disabled={disabled}
              onPress={() => group ? setModelPage([...modelPage, item.id]) : item.onPress()}
              className="min-h-11 flex-row items-center justify-between border-b border-border py-2 active:opacity-70">
              <View className="flex-1">
                <Text className="text-foreground">{item.title}</Text>
                {!group && item.subtitle ? <Text className="text-foreground-muted">{item.subtitle}</Text> : null}
              </View>
              {group || item.selected ? <SymbolView name={group ? "chevron.right" : "checkmark"} size={14} tintColorClassName="text-foreground-muted" /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    );
  }
  return (
    <ScrollView className="flex-1 bg-screen" contentContainerClassName="items-center px-6 pb-6 pt-10">
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
        <Text className="mt-1 text-[15px] text-foreground-muted">{callsUserLine(companion.callsUser, phoneLocale())}</Text>
      ) : null}
      {since ? <Text className="mt-0.5 text-[13px] text-foreground-muted">{since}</Text> : null}
      <Pressable accessibilityRole="button" onPress={openOptions} className="mt-6 rounded-full border border-border px-5 py-2.5 active:opacity-70">
        <Text className="font-t3-bold text-[15px] text-foreground">{copy.changePicture}</Text>
      </Pressable>
      {menu ? (
        <Pressable accessibilityRole="button" onPress={() => setModelPage([])} className="mt-2 rounded-full border border-border px-5 py-2.5 active:opacity-70">
          <Text className="font-t3-bold text-[15px] text-foreground">{copy.changeModel}</Text>
        </Pressable>
      ) : null}
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
    </ScrollView>
  );
}
