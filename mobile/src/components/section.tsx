import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "./text";

/**
 * A titled group on a page: a small label over what it holds, as a date heads the conversations
 * from that day. The label is quiet: the content is what a person reads.
 */
export function Section({
  title,
  leading,
  action,
  children,
}: {
  title?: string;
  /** What stands before the label: the orb of the Bot a group is for. */
  leading?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      {title || action ? (
        <View className="flex-row items-center justify-between px-1">
          {title ? (
            <View className="flex-1 flex-row items-center gap-1.5">
              {leading}
              <Text
                variant="caption"
                tone="muted"
                accessibilityRole="header"
                numberOfLines={1}
                className="flex-1 font-medium"
              >
                {title}
              </Text>
            </View>
          ) : null}
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}
