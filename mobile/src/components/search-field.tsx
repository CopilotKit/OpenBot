import { Pressable, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { IconSearch, IconX } from "../icons";
import { Icon } from "./icon";

/**
 * A search field under a tab's title, drawn as iOS draws the header's own: a quiet rounded field
 * with a magnifier, and a clear button once something is typed. Android's header can only offer
 * search as an icon, so Android uses this, and the two look alike.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
}) {
  const placeholderColor = useCSSVariable("--color-muted") as
    | string
    | undefined;
  return (
    <View className="h-10 flex-row items-center gap-2 rounded-xl bg-fill px-3">
      <Icon icon={IconSearch} size={18} color="accent-muted" />
      <TextInput
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={placeholderColor}
        returnKeyType="search"
        autoCorrect={false}
        className="h-10 flex-1 py-0 font-normal text-base text-foreground"
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={8}
          onPress={() => onChangeText("")}
          className="size-5 items-center justify-center rounded-full bg-muted/40"
        >
          <Icon icon={IconX} size={12} color="accent-background" />
        </Pressable>
      ) : null}
    </View>
  );
}
