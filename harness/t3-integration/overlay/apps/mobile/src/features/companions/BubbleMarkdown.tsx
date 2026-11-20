// Words in a room's bubble with the markdown they carry (lists, bold, links) and the media their
// file lines name, drawn the way the app draws a message in a thread, at the bubble's size and in
// the theme's colors (the person's bubble in the user-bubble colors).
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";

import { FONT_FAMILIES } from "../../lib/fontFamilies";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { MarkdownImageAvailableWidthContext } from "../threads/ThreadMarkdownImage";
import type { RoomMedia } from "./roomMedia";

/** How wide a bubble's content can be: 80% of the room's width inside its 16 pt sides, less the bubble's 14 pt sides. */
export function bubbleContentWidth(screenWidth: number) {
  return Math.floor((screenWidth - 32) * 0.8 - 28);
}

export function BubbleMarkdown(props: {
  readonly markdown: string;
  readonly body: { readonly fontSize: number; readonly lineHeight: number };
  readonly mine?: boolean;
  readonly media?: RoomMedia;
}) {
  const theme = useUniwindTheme();
  const regular = FONT_FAMILIES.regular;
  const bold = FONT_FAMILIES.bold;
  const { width } = useWindowDimensions();
  const mine = props.mine === true;
  const textStyle = useMemo(() => {
    const color = mine ? theme["--color-user-bubble-foreground"] : theme["--color-foreground"];
    return {
      color,
      strongColor: color,
      mutedColor: mine ? theme["--color-user-bubble-foreground-muted"] : theme["--color-foreground-muted"],
      linkColor: mine ? color : theme["--color-md-link"],
      inlineCodeColor: mine ? theme["--color-user-bubble-foreground-muted"] : theme["--color-foreground-secondary"],
      codeColor: mine ? theme["--color-md-user-code-text"] : theme["--color-md-code-text"],
      codeBackgroundColor: mine ? theme["--color-md-user-code-bg"] : theme["--color-md-code-bg"],
      codeBlockBackgroundColor: mine ? theme["--color-md-user-fence-bg"] : theme["--color-md-code-bg"],
      fileTextColor: mine ? color : theme["--color-md-code-text"],
      skillTextColor: color,
      quoteMarkerColor: mine ? color : theme["--color-md-blockquote-border"],
      dividerColor: mine ? color : theme["--color-md-hr"],
      fontSize: props.body.fontSize,
      lineHeight: props.body.lineHeight,
      headingFontSizes: [props.body.fontSize + 3, props.body.fontSize + 2, props.body.fontSize + 1],
      fontFamily: regular,
      headingFontFamily: bold,
      boldFontFamily: bold,
    };
  }, [theme, regular, bold, mine, props.body.fontSize, props.body.lineHeight]);
  const media = props.media;
  return (
    <MarkdownImageAvailableWidthContext value={bubbleContentWidth(width)}>
      <SelectableMarkdownText
        markdown={props.markdown}
        textStyle={textStyle}
        preserveSoftBreaks
        {...(media
          ? {
              onLinkPress: media.onLinkPress,
              onImagePress: media.onImagePress,
              resolveImageSource: media.resolveImageSource,
              renderImage: media.renderImage,
            }
          : {})}
      />
    </MarkdownImageAvailableWidthContext>
  );
}
