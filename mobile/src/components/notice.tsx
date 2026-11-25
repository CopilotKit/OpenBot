import type { ReactNode } from "react";
import { View } from "react-native";
import { IconAlertCircle, IconAlertTriangle, IconInfoCircle } from "../icons";
import { cn } from "./cn";
import { Icon } from "./icon";
import { Text } from "./text";

/**
 * A line that says something went wrong, or needs the person, and what to do next. `danger` is
 * for what failed; `warning` for what waits on them; `info` says no color at all.
 */
export function Notice({
  tone = "danger",
  message,
  action,
}: {
  tone?: "danger" | "warning" | "info";
  message?: string;
  action?: ReactNode;
}) {
  if (!message) return null;
  return (
    <View
      accessibilityRole="alert"
      className={cn(
        "flex-row items-start gap-2.5 rounded-lg border px-3 py-2.5",
        tone === "danger" && "border-danger/30 bg-danger/10",
        tone === "warning" && "border-warning/30 bg-warning/10",
        tone === "info" && "border-border bg-surface",
      )}
    >
      <View className="pt-0.5">
        <Icon
          icon={
            tone === "danger"
              ? IconAlertCircle
              : tone === "warning"
                ? IconAlertTriangle
                : IconInfoCircle
          }
          size={16}
          color={
            tone === "danger"
              ? "accent-danger"
              : tone === "warning"
                ? "accent-warning"
                : "accent-muted"
          }
        />
      </View>
      <View className="flex-1 gap-2">
        <Text className="text-sm leading-5">{message}</Text>
        {action}
      </View>
    </View>
  );
}
