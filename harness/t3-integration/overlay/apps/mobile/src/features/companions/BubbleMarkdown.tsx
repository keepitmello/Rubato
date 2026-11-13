// The companion's words in its bubble, with the markdown it writes (lists, bold, links) drawn the
// way the app draws an assistant's message, at the bubble's size and in the theme's colours.
import { useMemo } from "react";
import { Linking } from "react-native";

import { useFontFamily } from "../../lib/useFontFamily";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";

export function BubbleMarkdown(props: { readonly markdown: string }) {
  const theme = useUniwindTheme();
  const regular = useFontFamily("regular");
  const bold = useFontFamily("bold");
  const textStyle = useMemo(
    () => ({
      color: theme["--color-foreground"],
      strongColor: theme["--color-foreground"],
      mutedColor: theme["--color-foreground-muted"],
      linkColor: theme["--color-md-link"],
      inlineCodeColor: theme["--color-foreground-secondary"],
      codeColor: theme["--color-md-code-text"],
      codeBackgroundColor: theme["--color-md-code-bg"],
      codeBlockBackgroundColor: theme["--color-md-code-bg"],
      fileTextColor: theme["--color-md-code-text"],
      skillTextColor: theme["--color-foreground"],
      quoteMarkerColor: theme["--color-md-blockquote-border"],
      dividerColor: theme["--color-md-hr"],
      fontSize: 16,
      lineHeight: 22,
      headingFontSizes: [19, 18, 17, 16, 16, 16],
      fontFamily: regular,
      headingFontFamily: bold,
      boldFontFamily: bold,
    }),
    [theme, regular, bold],
  );
  return (
    <SelectableMarkdownText
      markdown={props.markdown}
      textStyle={textStyle}
      preserveSoftBreaks
      onLinkPress={(href) => void Linking.openURL(href).catch(() => undefined)}
    />
  );
}
