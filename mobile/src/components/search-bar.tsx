import { SearchField } from "heroui-native/search-field";
import { View } from "react-native";
import { IconPlus } from "../icons";
import { IconButton } from "./icon-button";
import { KeyboardBar } from "./keyboard-bar";

/**
 * The bar at the bottom of a list, in reach of a thumb: search what is listed, and start a new
 * one beside it. Inside a `KeyboardAvoidingView`, it stays above the keyboard while the person
 * types (./keyboard-bar.tsx).
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
  return (
    <KeyboardBar className="border-t border-border px-4 pt-2">
      <View className="flex-row items-center gap-2">
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
    </KeyboardBar>
  );
}
