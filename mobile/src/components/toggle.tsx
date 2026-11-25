import { Host, Switch } from "@expo/ui";
import { semantics } from "@expo/ui/jetpack-compose/modifiers";
import { accessibilityLabel } from "@expo/ui/swift-ui/modifiers";
import { Platform } from "react-native";

/**
 * An on/off switch, the platform's own (docs/app-guidelines.md, "What draws what"). `label` is what
 * a screen reader says for it, and is never drawn: the row around the switch shows its own words.
 */
export function Toggle({
  value,
  onValueChange,
  disabled,
  label,
}: {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Host matchContents>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        testID={label}
        // Said, never drawn: a label the switch drew would make the whole row its tap target.
        modifiers={
          Platform.OS === "ios"
            ? [accessibilityLabel(label)]
            : [semantics({ contentDescription: label })]
        }
      />
    </Host>
  );
}
