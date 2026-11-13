// Rubato: where the shell (workspace tabs, Stack.tsx) meets the companion screens. The
// screens themselves belong to features/companions; until they land, the tab says so
// instead of failing the build.
import type { StaticScreenProps } from "@react-navigation/native";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

export type CompanionRoomParams = {
  readonly companionId: string;
  readonly environmentId?: string;
  readonly threadId?: string;
};

export function CompanionListRouteScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-screen px-8">
      <Text className="text-center text-base text-foreground-muted">
        Your companions will appear here.
      </Text>
    </View>
  );
}

export function CompanionRoomRouteScreen(_props: StaticScreenProps<CompanionRoomParams>) {
  return <CompanionListRouteScreen />;
}
