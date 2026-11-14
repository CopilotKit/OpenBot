import { IconSunMoon } from "@tabler/icons-react";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { THEME_PREFERENCES, type ThemePreference } from "@/lib/theme";

const THEME_NAMES: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Light or dark. System follows the device and is where everybody starts. The choice is kept in this
 * browser, since the system it follows is this device's.
 */
export function ThemeRow() {
  const { theme, setTheme } = useTheme();

  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconSunMoon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Theme</ItemTitle>
        <ItemDescription>
          System matches your device's light or dark setting.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Select
          value={theme}
          onValueChange={(value) => {
            const choice = THEME_PREFERENCES.find((known) => known === value);
            if (choice) setTheme(choice);
          }}
        >
          <SelectTrigger aria-label="Theme">
            <SelectValue>{THEME_NAMES[theme]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {THEME_PREFERENCES.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {THEME_NAMES[choice]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ItemActions>
    </Item>
  );
}
