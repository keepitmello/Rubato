import { useContext, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { parse, SvgAst } from "react-native-svg";

import { MarkdownImageAvailableWidthContext } from "../features/threads/ThreadMarkdownImage";
import {
  resolveMarkdownImageDisplaySize,
  resolveSvgImageSize,
} from "../features/threads/markdownImageSize";
import { safeSvgTree } from "../lib/rubatoSvgFigure";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

type ParsedSvg = { readonly ast: ReturnType<typeof parse>; readonly width: number; readonly height: number };

function parseFigure(code: string): ParsedSvg | null {
  try {
    const ast = parse(code.trim(), safeSvgTree);
    if (!ast || ast.tag !== "svg") return null;
    const size = resolveSvgImageSize(ast.props);
    return size ? { ast, width: size.width, height: size.height } : null;
  } catch {
    return null;
  }
}

/**
 * A complete ```svg fence as the picture it draws (reply-visuals-edits.mjs): in the text colour, so
 * `currentColor` follows light and dark, as wide as it was drawn and never wider than the message,
 * with the fence's title under it. Not an SVG picture, it returns undefined and the fence stays code.
 */
export function rubatoSvgBlock(
  code: string,
  title: string | undefined,
  textStyle: NativeMarkdownTextStyle,
) {
  const figure = parseFigure(code);
  return figure ? <RubatoSvgFigure figure={figure} title={title} textStyle={textStyle} /> : undefined;
}

function RubatoSvgFigure(props: {
  readonly figure: ParsedSvg;
  readonly title: string | undefined;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  const { figure, title, textStyle } = props;
  const contextWidth = useContext(MarkdownImageAvailableWidthContext);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const availableWidth =
    measuredWidth > 0 && contextWidth > 0 ? Math.min(contextWidth, measuredWidth) : contextWidth || measuredWidth;
  const size = useMemo(
    () =>
      availableWidth > 0
        ? resolveMarkdownImageDisplaySize({
            sourceWidth: figure.width,
            sourceHeight: figure.height,
            availableWidth,
          })
        : null,
    [availableWidth, figure.width, figure.height],
  );
  return (
    <View
      style={styles.figure}
      onLayout={(event) => setMeasuredWidth(Math.floor(event.nativeEvent.layout.width))}
      accessible
      accessibilityRole="image"
      accessibilityLabel={title}
    >
      {size ? (
        <SvgAst
          ast={figure.ast}
          override={{
            width: size.width,
            height: size.height,
            color: textStyle.color,
            viewBox:
              typeof figure.ast?.props.viewBox === "string"
                ? figure.ast.props.viewBox
                : `0 0 ${figure.width} ${figure.height}`,
          }}
        />
      ) : null}
      {title ? (
        <Text
          style={[
            styles.caption,
            { color: textStyle.mutedColor, fontFamily: textStyle.fontFamily, fontSize: textStyle.fontSize * 0.8 },
          ]}
        >
          {title}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  figure: { alignSelf: "stretch", marginVertical: 6 },
  caption: { marginTop: 6 },
});
