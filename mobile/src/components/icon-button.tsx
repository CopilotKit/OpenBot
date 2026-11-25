import { Pressable } from "react-native";
import type { TablerIcon } from "../icons";
import { cn } from "./cn";
import { Icon } from "./icon";

/**
 * A control that is only an icon: a header's menu and settings, the message box's attach and
 * send. It always has a label for a screen reader. `primary` is the main action, filled.
 */
export function IconButton({
  icon,
  label,
  onPress,
  variant = "ghost",
  size = "md",
  disabled,
}: {
  icon: TablerIcon;
  label: string;
  onPress?: () => void;
  variant?: "ghost" | "outline" | "primary";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      className={cn(
        "items-center justify-center rounded-full",
        size === "sm" && "size-8",
        size === "md" && "size-10",
        size === "lg" && "size-12",
        variant === "ghost" && "active:bg-fill",
        variant === "outline" &&
          "border border-border bg-surface active:bg-fill",
        variant === "primary" && "bg-accent active:opacity-80",
        disabled && "opacity-40",
      )}
    >
      <Icon
        icon={icon}
        size={size === "sm" ? 18 : 22}
        color={
          variant === "primary"
            ? "accent-accent-foreground"
            : "accent-foreground"
        }
      />
    </Pressable>
  );
}
