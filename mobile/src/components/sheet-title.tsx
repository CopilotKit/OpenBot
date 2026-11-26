import { Platform, View } from "react-native";
import { cn } from "./cn";
import { Text } from "./text";

/**
 * A sheet's handle and title on Android. iOS draws both on its own sheet (the grabber, and the
 * header's title), where Android's sheet has neither, so a sheet opened there would start with no
 * word of what it is. On Android this draws Material's drag handle and the title under it, at the
 * size iOS's sheet title has, so the two read alike. iOS draws nothing here.
 */
export function SheetTitle({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  if (Platform.OS !== "android") return null;
  return (
    <View className={cn("items-center gap-3 pt-2 pb-1", className)}>
      <View className="h-1 w-8 rounded-full bg-muted/40" />
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        className="font-semibold text-[17px]"
      >
        {title}
      </Text>
    </View>
  );
}
