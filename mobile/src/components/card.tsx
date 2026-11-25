import type { ReactNode } from "react";
import { View } from "react-native";
import { cn } from "./cn";

/**
 * One thing on its own, as a card: a memory, an item that needs you, an approval. The scheme's
 * `card` with a hairline border and no shadow, like `Rows`. `highlighted` rings the one a link or a
 * notification opened.
 */
export function Card({
  children,
  highlighted,
  className,
}: {
  children: ReactNode;
  highlighted?: boolean;
  className?: string;
}) {
  return (
    <View
      className={cn(
        "gap-2 rounded-lg border border-border bg-surface p-4",
        highlighted && "border-2 border-focus",
        className,
      )}
    >
      {children}
    </View>
  );
}
