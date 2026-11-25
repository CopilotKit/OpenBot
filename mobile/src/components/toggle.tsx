import { Host, Switch } from "@expo/ui";

/** An on/off switch, the platform's own (docs/app-guidelines.md, "What draws what"). */
export function Toggle({
  value,
  onValueChange,
  disabled,
  label,
}: {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Host matchContents>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        testID={label}
      />
    </Host>
  );
}
