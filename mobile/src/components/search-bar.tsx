import { SearchField } from "heroui-native/search-field";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconPlus } from "../icons";
import { IconButton } from "./icon-button";

/**
 * The bar at the bottom of a list, in reach of a thumb: search what is listed, and start a new
 * one beside it.
 */
export function SearchBar({
  value,
  onChange,
  placeholder,
  newLabel,
  onNew,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  newLabel?: string;
  onNew?: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-row items-center gap-2 border-t border-border bg-background px-4 pt-2"
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
    >
      <SearchField value={value} onChange={onChange} className="flex-1">
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder={placeholder} />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
      {onNew && newLabel ? (
        <IconButton
          icon={IconPlus}
          label={newLabel}
          variant="outline"
          onPress={onNew}
        />
      ) : null}
    </View>
  );
}
