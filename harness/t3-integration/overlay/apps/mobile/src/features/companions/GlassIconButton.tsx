import { Pressable } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";

/** A round glass button, as iOS draws the controls of its glass bars. */
export function GlassIconButton(props: {
  readonly label: string;
  readonly icon: string;
  readonly onPress: () => void;
  readonly size?: number;
}) {
  const size = props.size ?? 44;
  return (
    <GlassSurface style={{ width: size, height: size, borderRadius: size / 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        onPress={props.onPress}
        hitSlop={6}
        className="flex-1 items-center justify-center active:opacity-60"
      >
        <SymbolView name={{ ios: props.icon as never, android: "smartphone" }} size={size * 0.4} tintColorClassName="accent-foreground" />
      </Pressable>
    </GlassSurface>
  );
}
