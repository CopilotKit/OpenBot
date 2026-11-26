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
  iconless,
}: {
  children: ReactNode;
  className?: string;
  /** Rows with no glyph tile: the dividers start at the text instead of after the tile. */
  iconless?: boolean;
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
          {index > 0 ? (
            <Separator
              className={cn(iconless ? "ml-3" : "ml-14", "bg-border")}
            />
          ) : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

/**
 * A row: a 16px glyph on a 32px tile with a hairline ring, a title, a line under it, and what it
 * opens. Pressable when it opens something, with a chevron unless it brings its own control. A row
 * that does something where it is (Sign out, Run now) rather than opening a page has no chevron.
 */
export function Row({
  icon,
  title,
  description,
  trailing,
  onPress,
  tone = "default",
  alert,
  chevron = true,
  accessibilityLabel,
}: {
  icon?: TablerIcon;
  title: string;
  description?: string;
  /** A line under the description, in the color of what failed: "Last run failed". */
  alert?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  tone?: "default" | "danger";
  /** False for a row that acts in place instead of opening a page: no chevron. */
  chevron?: boolean;
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
        <Text
          variant="label"
          tone={tone === "danger" ? "danger" : "default"}
          numberOfLines={2}
        >
          {title}
        </Text>
        {description ? (
          <Text variant="caption" tone="muted" numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        {alert ? (
          <Text variant="caption" tone="danger" numberOfLines={2}>
            {alert}
          </Text>
        ) : null}
      </View>
      {trailing ??
        (onPress && chevron ? (
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
