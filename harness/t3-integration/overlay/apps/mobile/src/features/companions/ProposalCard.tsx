// A change the companion proposes to itself, as a card in its room (the accepted mockup's third
// phone): where in its text, the passage with removed words struck through and new words marked,
// and apply / "더 고쳐줘". Nothing changes on the Mac until apply; "더 고쳐줘" only keeps talking.
// A drawn picture comes the same way, shown round as it would be.
import { Image } from "expo-image";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { copy } from "./copy";
import { compactDiff, wordDiff, type Proposal } from "./proposalModel";

function CardButton(props: {
  readonly label: string;
  readonly kind: "primary" | "secondary" | "plain";
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const shell =
    props.kind === "primary"
      ? "rounded-full bg-primary px-4 py-2 active:opacity-80"
      : props.kind === "secondary"
        ? "rounded-full border border-border px-4 py-2 active:opacity-70"
        : "px-2 py-2 active:opacity-60";
  const text =
    props.kind === "primary"
      ? "font-t3-bold text-[14px] text-primary-foreground"
      : props.kind === "secondary"
        ? "font-t3-bold text-[14px] text-foreground"
        : "text-[14px] text-foreground-muted";
  return (
    <Pressable accessibilityRole="button" disabled={props.disabled} onPress={props.onPress} className={shell} hitSlop={4}>
      <Text className={text}>{props.label}</Text>
    </Pressable>
  );
}

export function ProposalCard(props: {
  readonly proposal: Proposal;
  readonly body: { readonly fontSize: number; readonly lineHeight: number };
  readonly busy: boolean;
  readonly onApply: () => void;
  readonly onMore: () => void;
  readonly onDecline: () => void;
}) {
  const { proposal } = props;
  const diff = useMemo(
    () => (proposal.kind === "piece" ? compactDiff(wordDiff(proposal.before, proposal.after)) : []),
    [proposal],
  );
  const open = proposal.status === "open";
  return (
    <View
      className="mt-2.5 self-stretch rounded-[18px] border border-border bg-grouped-card px-3.5 py-3"
      style={{ opacity: proposal.status === "declined" ? 0.6 : 1 }}
    >
      {proposal.label ? (
        <Text numberOfLines={2} className="mb-1.5 text-[12px] text-foreground-muted">
          {proposal.label}
        </Text>
      ) : null}
      {proposal.kind === "piece" ? (
        <Text selectable className="text-foreground" style={props.body}>
          {diff.map((part, index) =>
            part.kind === "same" ? (
              part.text
            ) : (
              <Text
                key={index}
                className={
                  part.kind === "del"
                    ? "bg-adaptive-rose-500-a12-a16 text-adaptive-rose-700-300 line-through"
                    : "bg-adaptive-emerald-500-a12-a16 text-adaptive-emerald-700-300"
                }
              >
                {part.text}
              </Text>
            ),
          )}
        </Text>
      ) : (
        <View className="items-center py-1">
          <Image
            source={{ uri: proposal.image }}
            contentFit="cover"
            style={{ width: 132, height: 132, borderRadius: 66 }}
            accessibilityIgnoresInvertColors
          />
        </View>
      )}
      {open ? (
        <View className="mt-3 flex-row items-center gap-2">
          <CardButton
            label={proposal.kind === "avatar" ? copy.pictureApply : copy.apply}
            kind="primary"
            disabled={props.busy}
            onPress={props.onApply}
          />
          <CardButton label={copy.more} kind="secondary" disabled={props.busy} onPress={props.onMore} />
          <View className="flex-1" />
          {props.busy ? <ActivityIndicator /> : <CardButton label={copy.keepAsIs} kind="plain" onPress={props.onDecline} />}
        </View>
      ) : (
        <Text
          className={
            proposal.status === "applied"
              ? "mt-2 font-t3-bold text-[13px] text-adaptive-emerald-700-300"
              : "mt-2 text-[13px] text-foreground-muted"
          }
        >
          {proposal.status === "applied" ? `✓ ${copy.applied}` : copy.declined}
        </Text>
      )}
    </View>
  );
}
