import type { ReactNode } from "react";
import { View } from "react-native";
import type { TablerIcon } from "../icons";
import { Icon } from "./icon";
import { Text } from "./text";

/**
 * What a list shows while it has nothing in it: what will appear, and how to make it appear
 * ("No conversations yet. Start one with a Bot.").
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: TablerIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <View className="items-center gap-3 px-8 py-12">
      {icon ? (
        <View className="size-12 items-center justify-center rounded-lg border border-border bg-surface">
          <Icon icon={icon} size={22} color="accent-muted" />
        </View>
      ) : null}
      <View className="items-center gap-1">
        <Text variant="label" className="text-center">
          {title}
        </Text>
        {description ? (
          <Text tone="muted" className="text-center text-sm leading-5">
            {description}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}
