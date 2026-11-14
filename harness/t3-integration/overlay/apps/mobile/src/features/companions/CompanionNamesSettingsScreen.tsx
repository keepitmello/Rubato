// Settings › Companions: what this phone calls each companion (user 3efe742c). A blank field goes
// back to the Korean default; the Mac and the desktop keep their own names. Below, for each
// companion that takes calls, how much it thinks on a call; that one is the Mac's setting, the
// same as the desktop's Settings › Companion.
import { useEffect, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { CompanionAvatar } from "./CompanionAvatar";
import { companionRename, DEFAULT_COMPANION_NAMES, renameCompanion, useCompanionNames } from "./companionNames";
import { CALL_EFFORTS, saveCallEffort, useCompanions, type CallEffort, type CompanionEntry } from "./companionsStore";
import { copy } from "./copy";

const EFFORT_COPY: Record<CallEffort, { readonly label: string; readonly detail: string }> = {
  conversation: { label: copy.callEffortConversation, detail: copy.callEffortConversationDetail },
  low: { label: copy.callEffortLow, detail: copy.callEffortLowDetail },
  medium: { label: copy.callEffortMedium, detail: copy.callEffortMediumDetail },
  high: { label: copy.callEffortHigh, detail: copy.callEffortHighDetail },
};

function CallThinkingSection(props: { readonly companion: CompanionEntry; readonly titled: boolean }) {
  const { companion } = props;
  const choose = (effort: CallEffort) => {
    if (effort === companion.callEffort) return;
    saveCallEffort(companion, effort).catch((error: unknown) =>
      Alert.alert(copy.saveFailed, error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <SettingsSection
      title={props.titled ? `${companion.title} · ${copy.callThinking}` : copy.callThinking}
      footer={copy.callThinkingFooter}
    >
      {CALL_EFFORTS.map((effort, index) => (
        <SettingsChoiceRow
          key={effort}
          label={EFFORT_COPY[effort].label}
          description={EFFORT_COPY[effort].detail}
          selected={companion.callEffort === effort}
          separated={index > 0}
          onPress={() => choose(effort)}
        />
      ))}
    </SettingsSection>
  );
}

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
  const callers = companions.filter((companion) => companion.calls);
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
        {callers.map((companion) => (
          <CallThinkingSection
            key={`call:${companion.environmentId}:${companion.id}`}
            companion={companion}
            titled={callers.length > 1 || companions.length > 1}
          />
        ))}
      </ScrollView>
    </View>
  );
}
