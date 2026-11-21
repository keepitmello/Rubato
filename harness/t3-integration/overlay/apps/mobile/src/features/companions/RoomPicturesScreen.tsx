// "대화에 온 사진에서 고르기": the pictures in a companion's room, newest first, as a grid in a
// sheet (pictureModel.ts roomPictures). The one the person taps is fetched from the Mac and opens in
// the circle (AvatarCropScreen), which closes this sheet with itself when done.
import { CommonActions, useNavigation, useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { buildThreadFeed } from "../../lib/threadActivity";
import { useAssetUrl } from "../../state/assets";
import { fetchRoomPicture } from "./avatarPicture";
import { copy } from "./copy";
import { roomPictures, type PictureMessage, type RoomPicture } from "./pictureModel";
import { useRoomThread, useRoomTurnItems } from "./roomThread";

export type CompanionPicturesParams = {
  readonly companionId: string;
  readonly environmentId: string;
  readonly threadId: string;
};

const COLUMNS = 3;
const GAP = 4;

function Tile(props: {
  readonly environmentId: EnvironmentId;
  readonly picture: RoomPicture;
  readonly size: number;
  readonly busy: boolean;
  readonly onPress: () => void;
}) {
  const uri = useAssetUrl(props.environmentId, props.picture.resource);
  return (
    <Pressable accessibilityRole="imagebutton" onPress={props.onPress} className="active:opacity-70">
      <View className="overflow-hidden rounded-[6px] bg-grouped-card" style={{ width: props.size, height: props.size }}>
        {uri ? (
          <Image source={{ uri }} contentFit="cover" style={{ width: props.size, height: props.size }} accessibilityIgnoresInvertColors />
        ) : null}
        {props.busy ? (
          <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.35)" }}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function RoomPicturesScreen(_props: StaticScreenProps<CompanionPicturesParams>) {
  const route = useRoute<RouteProp<Record<string, CompanionPicturesParams>>>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const environmentId = route.params.environmentId as EnvironmentId;
  const threadId = route.params.threadId as ThreadId;
  const target = { environmentId, threadId };
  useRoomThread(target);
  const items = useRoomTurnItems(target);
  const pictures = useMemo(
    () =>
      roomPictures(
        buildThreadFeed(items).flatMap((entry): PictureMessage[] =>
          entry.type === "message"
            ? [{ id: entry.message.id, role: entry.message.role, text: entry.message.text, createdAt: entry.message.createdAt, attachments: entry.message.attachments }]
            : [],
        ),
        threadId,
      ),
    [items, threadId],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const size = Math.floor((width - 32 - GAP * (COLUMNS - 1)) / COLUMNS);
  const choose = async (picture: RoomPicture) => {
    if (busy) return;
    setBusy(picture.key);
    await fetchRoomPicture(environmentId, picture.resource).then(
      (prepared) =>
        navigation.dispatch(
          CommonActions.navigate("CompanionAvatarCrop", {
            companionId: route.params.companionId,
            environmentId,
            uri: prepared.uri,
            width: String(prepared.width),
            height: String(prepared.height),
            depth: "2",
          }),
        ),
      (error: unknown) => Alert.alert(copy.pictureFailed, error instanceof Error ? error.message : String(error)),
    );
    setBusy(null);
  };
  return (
    <View className="flex-1 bg-screen">
      <Text className="px-4 pb-3 pt-5 font-t3-bold text-[17px] text-foreground">{copy.roomPictures}</Text>
      <FlatList
        data={pictures}
        numColumns={COLUMNS}
        keyExtractor={(item) => item.key}
        columnWrapperStyle={{ gap: GAP }}
        contentContainerStyle={{ paddingHorizontal: 16, gap: GAP, paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        renderItem={({ item }) => (
          <Tile environmentId={environmentId} picture={item} size={size} busy={busy === item.key} onPress={() => void choose(item)} />
        )}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center pb-16">
            <Text className="text-[15px] text-foreground-muted">{copy.noRoomPictures}</Text>
          </View>
        }
      />
    </View>
  );
}
