import SegmentedControl from "@expo/ui/community/segmented-control";
import { useUniwind } from "uniwind";

/**
 * A choice between a few views of one thing, the platform's own segmented control: a Bot's
 * Conversations and Settings.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const { theme } = useUniwind();
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <SegmentedControl
      accessibilityLabel={label}
      values={options.map((option) => option.label)}
      selectedIndex={index}
      appearance={theme === "dark" ? "dark" : "light"}
      onChange={(event) => {
        const next = options[event.nativeEvent.selectedSegmentIndex];
        if (next) onChange(next.value);
      }}
      style={{ alignSelf: "stretch" }}
    />
  );
}
