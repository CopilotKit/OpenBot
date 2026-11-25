import type { ReactNode } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { cn } from "./cn";

/** A screen's ground: the scheme's `background`, under the native header the route draws. */
export function Screen({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <View className={cn("flex-1 bg-background", className)}>{children}</View>
  );
}

/**
 * A screen that scrolls, with pull to refresh when it can load again. For a short page of
 * sections. A long list (conversations, messages) is a `FlatList` instead (docs/app-guidelines.md).
 */
export function ScrollScreen({
  children,
  refreshing,
  onRefresh,
  className,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  className?: string;
}) {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName={cn("gap-6 px-4 pt-4 pb-12", className)}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <Refresh refreshing={Boolean(refreshing)} onRefresh={onRefresh} />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

/** Pull to refresh, its spinner in the scheme's quieter text color. */
export function Refresh({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const color = useCSSVariable("--color-muted") as string | undefined;
  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={color}
      colors={color ? [color] : undefined}
    />
  );
}
