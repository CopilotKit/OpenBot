import { Separator } from "heroui-native/separator";
import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { TablerIcon } from "../icons";
import { IconChevronRight } from "../icons";
import { cn } from "./cn";
import { Icon } from "./icon";
import { Text } from "./text";

/**
 * One card of rows with hairline dividers, the web app's `PageRows`: settings, a Bot's parts, a
 * list of routines. The card is the scheme's `card` with a hairline border, and no shadow.
 */
export function Rows({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-surface",
        className,
      )}
    >
      {rows.map((row, index) => (
        <Fragment key={row.key ?? index}>
          {index > 0 ? <Separator className="ml-14 bg-border" /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

/**
 * A row: a 16px glyph on a 32px tile with a hairline ring, a title, a line under it, and what it
 * opens. Pressable when it opens something, with a chevron unless it brings its own control.
 */
export function Row({
  icon,
  title,
  description,
  trailing,
  onPress,
  tone = "default",
  accessibilityLabel,
}: {
  icon?: TablerIcon;
  title: string;
  description?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  tone?: "default" | "danger";
  accessibilityLabel?: string;
}) {
  const content = (
    <View className="min-h-14 flex-row items-center gap-3 px-3 py-2.5">
      {icon ? (
        <View className="size-8 items-center justify-center rounded-md border border-border bg-background">
          <Icon
            icon={icon}
            size={16}
            color={tone === "danger" ? "accent-danger" : "accent-muted"}
          />
        </View>
      ) : null}
      <View className="flex-1 gap-0.5">
        <Text variant="label" tone={tone === "danger" ? "danger" : "default"}>
          {title}
        </Text>
        {description ? (
          <Text variant="caption" tone="muted" numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
      {trailing ??
        (onPress ? (
          <Icon icon={IconChevronRight} size={16} color="accent-muted" />
        ) : null)}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      className="active:bg-fill"
    >
      {content}
    </Pressable>
  );
}
