import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, type ViewStyle } from "react-native";

const frame: ViewStyle = {
  borderRadius: 6,
  alignItems: "center",
  justifyContent: "center",
};

/** Paseo-style rounded-square icon button with a surface2 hover/press background. */
export function IconButton({
  name,
  label,
  onPress,
  theme,
  size = 16,
  frameSize = 28,
}: {
  name: string;
  label: string;
  onPress(): void;
  theme: PluginTheme;
  size?: number;
  /** Outer square size; defaults to 28. */
  frameSize?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        frame,
        { width: frameSize, height: frameSize },
        hovered || pressed ? { backgroundColor: theme.colors.surface2 } : null,
      ]}
    >
      <Icon name={name} size={size} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}
