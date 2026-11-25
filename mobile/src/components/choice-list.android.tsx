import {
  Column,
  HorizontalDivider,
  Host,
  RadioButton,
  Row,
  Text,
} from "@expo/ui/jetpack-compose";
import {
  defaultMinSize,
  fillMaxWidth,
  padding,
  selectableGroup,
  semantics,
  toggleable,
  weight,
} from "@expo/ui/jetpack-compose/modifiers";
import { Fragment } from "react";
import { View } from "react-native";
import { useCSSVariable, useUniwind } from "uniwind";
import type { ChoiceListProps } from "./choice-list";

export function ChoiceList<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  label,
}: ChoiceListProps<T>) {
  const { theme } = useUniwind();
  const [foreground, muted, border] = useCSSVariable([
    "--color-foreground",
    "--color-muted",
    "--color-border",
  ]) as (string | undefined)[];

  return (
    <View className="overflow-hidden rounded-lg border border-border bg-surface">
      <Host
        colorScheme={theme === "dark" ? "dark" : "light"}
        matchContents={{ vertical: true }}
        style={{ width: "100%" }}
      >
        <Column
          modifiers={[
            selectableGroup(),
            semantics({ contentDescription: label }),
          ]}
        >
          {options.map((option, index) => {
            const chosen = option.value === value;
            return (
              <Fragment key={option.value}>
                {index > 0 ? <HorizontalDivider color={border} /> : null}
                <Row
                  horizontalArrangement={{ spacedBy: 12 }}
                  verticalAlignment="center"
                  modifiers={[
                    fillMaxWidth(),
                    defaultMinSize({ minHeight: 48 }),
                    // The row owns activation so the label and indicator are a single focus target.
                    // Expo UI's selectable modifier cannot mark a row disabled.
                    toggleable(
                      chosen,
                      () => {
                        if (!chosen) onChange(option.value);
                      },
                      { role: "radioButton", enabled: !disabled },
                    ),
                    padding(12, 8, 12, 8),
                  ]}
                >
                  <Text
                    color={disabled ? muted : foreground}
                    modifiers={[weight(1)]}
                    style={{
                      fontFamily: "Inter_500Medium",
                      fontSize: 14,
                    }}
                  >
                    {option.label}
                  </Text>
                  <RadioButton
                    selected={chosen}
                    enabled={!disabled}
                    colors={{
                      selectedColor: foreground,
                      unselectedColor: muted,
                      disabledSelectedColor: muted,
                      disabledUnselectedColor: muted,
                    }}
                  />
                </Row>
              </Fragment>
            );
          })}
        </Column>
      </Host>
    </View>
  );
}
