import { Image } from "expo-image";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/** A companion's face in a circle: its art cropped to the middle, or its initial. */
export function CompanionAvatar(props: {
  readonly art: string | null;
  readonly title: string;
  readonly size: number;
  readonly ring?: boolean;
}) {
  const { size } = props;
  return (
    <View
      className={props.ring ? "items-center justify-center rounded-full bg-background" : "items-center justify-center rounded-full"}
      style={{
        width: size,
        height: size,
        ...(props.ring
          ? { shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, padding: 3 }
          : {}),
      }}
    >
      {props.art ? (
        <Image
          source={{ uri: props.art }}
          contentFit="cover"
          style={{ width: props.ring ? size - 6 : size, height: props.ring ? size - 6 : size, borderRadius: size }}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View
          className="items-center justify-center rounded-full bg-[#E9F8EC] dark:bg-[#1F3A25]"
          style={{ width: props.ring ? size - 6 : size, height: props.ring ? size - 6 : size }}
        >
          <Text className="font-t3-bold text-[#2E9E46] dark:text-[#8FE3A0]" style={{ fontSize: size * 0.4 }}>
            {[...props.title][0]?.toUpperCase() ?? "·"}
          </Text>
        </View>
      )}
    </View>
  );
}
