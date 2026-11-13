// Settings › Companions: what this phone calls each companion (user 3efe742c). A blank field goes
// back to the Korean default; the Mac and the desktop keep their own names.
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SettingsSection } from "../settings/components/SettingsSection";
import { CompanionAvatar } from "./CompanionAvatar";
import { companionRename, DEFAULT_COMPANION_NAMES, renameCompanion, useCompanionNames } from "./companionNames";
import { useCompanions, type CompanionEntry } from "./companionsStore";
import { copy } from "./copy";

function NameRow(props: { readonly companion: CompanionEntry; readonly separated: boolean }) {
  const { companion } = props;
  const names = useCompanionNames();
  const [draft, setDraft] = useState(companionRename(companion.id) ?? "");
  // A rename made elsewhere (another row's save does not touch this one) shows here.
  useEffect(() => setDraft(companionRename(companion.id) ?? ""), [names, companion.id]);
  const fallback = DEFAULT_COMPANION_NAMES[companion.id] ?? companion.macTitle;
  return (
    <View className={props.separated ? "flex-row items-center gap-3 border-t border-border px-4 py-3" : "flex-row items-center gap-3 px-4 py-3"}>
      <CompanionAvatar art={companion.art} title={companion.title} size={40} />
      <View className="min-w-0 flex-1">
        <TextInput
          accessibilityLabel={`${companion.macTitle} ${copy.nameLabel}`}
          value={draft}
          onChangeText={setDraft}
          onEndEditing={() => renameCompanion(companion.id, draft)}
          onSubmitEditing={() => renameCompanion(companion.id, draft)}
          placeholder={fallback}
          placeholderTextColorClassName="accent-foreground-muted"
          returnKeyType="done"
          autoCorrect={false}
          className="font-sans text-base text-foreground"
        />
        <Text className="mt-0.5 text-xs text-foreground-muted">
          {copy.onTheMac} {companion.macTitle}
        </Text>
      </View>
    </View>
  );
}

export function CompanionNamesSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { companions } = useCompanions();
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ title: copy.companionsSettings }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={copy.names} footer={copy.namesFooter}>
          <View className="overflow-hidden rounded-[22px] bg-card">
            {companions.map((companion, index) => (
              <NameRow key={`${companion.environmentId}:${companion.id}`} companion={companion} separated={index > 0} />
            ))}
          </View>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
