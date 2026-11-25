import { View } from "react-native";
import { Text } from "./text";

/** A person, as their initials in a quiet circle. */
export function PersonAvatar({
  name,
  size = 36,
}: {
  name: string;
  size?: number;
}) {
  const initials = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
      className="items-center justify-center rounded-full border border-border bg-fill"
      style={{ width: size, height: size }}
    >
      <Text variant="caption" className="font-semibold">
        {initials || "?"}
      </Text>
    </View>
  );
}
