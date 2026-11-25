import { Platform } from "react-native";
import { cn } from "./cn";
import { Text } from "./text";

/**
 * A tab's large title on Android. iOS draws it in the native header, where Android's header has no
 * large title, so on Android it opens the screen's content instead, at the size and weight iOS
 * uses: the two look alike. iOS draws nothing here.
 */
export function TabTitle({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  if (Platform.OS !== "android") return null;
  return (
    <Text
      accessibilityRole="header"
      className={cn("font-bold text-[34px] leading-[41px]", className)}
    >
      {title}
    </Text>
  );
}
