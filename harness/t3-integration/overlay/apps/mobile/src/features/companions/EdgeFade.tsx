// The scroll edge under a floating bar: content fades into the screen color instead of being cut,
// as iOS draws it under its own glass bars. The color is the theme's, so it follows the theme.
import { useId } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { useUniwindTheme } from "../../lib/useUniwindTheme";

export function EdgeFade(props: { readonly edge: "top" | "bottom"; readonly height: number; readonly solid?: number }) {
  const theme = useUniwindTheme();
  const color = theme["--color-screen"];
  const id = `edge-fade-${useId().replace(/:/g, "")}`;
  // `solid` of the height stays fully opaque next to the edge, then it fades out.
  const solid = Math.min(Math.max(props.solid ?? 0.55, 0), 0.95);
  const top = props.edge === "top";
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, height: props.height, ...(top ? { top: 0 } : { bottom: 0 }) }}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1={top ? "0" : "1"} x2="0" y2={top ? "1" : "0"}>
            <Stop offset="0" stopColor={color} stopOpacity={1} />
            <Stop offset={String(solid)} stopColor={color} stopOpacity={1} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
