// Where a new companion's first conversation stands, as chips under the room's header (the
// accepted mockup's second phone): a topic settled shows a check, one left for later says so, and
// the four it needs come first (onboardingModel.ts).
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { copy, type CopyKey } from "./copy";
import type { Onboarding, OnboardingItem, OnboardingKey } from "./onboardingModel";

const LABEL: Readonly<Record<OnboardingKey, CopyKey>> = {
  name: "onboardingName",
  callsUser: "onboardingCallsUser",
  work: "onboardingWork",
  relationship: "onboardingRelationship",
  look: "onboardingLook",
  speech: "onboardingSpeech",
  closeness: "onboardingCloseness",
};

function Chip(props: { readonly item: OnboardingItem }) {
  const { item } = props;
  const label = copy[LABEL[item.key]];
  const done = item.state === "set";
  const later = item.state === "deferred";
  return (
    <View
      accessibilityLabel={`${label}${done ? `, ${copy.onboardingSet}${item.value ? ` ${item.value}` : ""}` : later ? `, ${copy.onboardingLater}` : ""}`}
      className={
        done
          ? "rounded-full bg-adaptive-emerald-500-a12-a16 px-2.5 py-1"
          : later
            ? "rounded-full border border-dashed border-border px-2.5 py-1"
            : "rounded-full bg-grouped-card px-2.5 py-1"
      }
    >
      <Text
        className={
          done
            ? "font-t3-bold text-[12px] text-adaptive-emerald-700-300"
            : "text-[12px] text-foreground-muted"
        }
      >
        {done ? `${label} ✓` : later ? `${label} · ${copy.onboardingLater}` : label}
      </Text>
    </View>
  );
}

export function OnboardingChips(props: { readonly onboarding: Onboarding }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingVertical: 6 }}
    >
      {props.onboarding.items.map((item) => (
        <Chip key={item.key} item={item} />
      ))}
    </ScrollView>
  );
}
