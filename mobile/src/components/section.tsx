import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "./text";

/**
 * A titled group on a page: a small label over what it holds, as a date heads the conversations
 * from that day. The label is quiet: the content is what a person reads.
 */
export function Section({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      {title || action ? (
        <View className="flex-row items-center justify-between px-1">
          {title ? (
            <Text
              variant="caption"
              tone="muted"
              accessibilityRole="header"
              className="font-medium"
            >
              {title}
            </Text>
          ) : null}
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}
