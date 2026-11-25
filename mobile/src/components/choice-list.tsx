import { Fragment } from "react";
import { Pressable, View } from "react-native";
import { IconCheck } from "../icons";
import { cn } from "./cn";
import { Icon } from "./icon";
import { Text } from "./text";

/**
 * One choice from a short list whose options are sentences, too long for a segmented control: the
 * options as rows, the chosen one with a check, as the platforms' own settings lists draw it.
 */
export function ChoiceList<T extends string>({
  options,
  value,
  onChange,
  disabled,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      className="overflow-hidden rounded-lg border border-border bg-surface"
    >
      {options.map((option, index) => {
        const chosen = option.value === value;
        return (
          <Fragment key={option.value}>
            {index > 0 ? <View className="ml-3 h-px bg-border" /> : null}
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: chosen, disabled }}
              disabled={disabled}
              onPress={() => {
                if (!chosen) onChange(option.value);
              }}
              className={cn(
                "min-h-11 flex-row items-center gap-3 px-3 py-2.5 active:bg-fill",
                disabled && "opacity-50",
              )}
            >
              <Text variant="label" className="flex-1 text-sm">
                {option.label}
              </Text>
              {chosen ? (
                <Icon icon={IconCheck} size={18} color="accent-foreground" />
              ) : null}
            </Pressable>
          </Fragment>
        );
      })}
    </View>
  );
}
