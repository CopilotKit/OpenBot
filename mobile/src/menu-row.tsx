import MenuView, { type MenuAction } from "@expo/ui/community/menu";
import { useState } from "react";
import { View } from "react-native";
import { Icon, Row } from "./components";
import type { TablerIcon } from "./icons";
import { IconSelector } from "./icons";

/** One choice in a row's menu: `on` marks the current answer. */
export type MenuChoice = {
  id: string;
  title: string;
  on?: boolean;
  destructive?: boolean;
};

/** A group of choices, drawn as a section of the menu, with a heading where it has one. */
export type MenuGroup = { title?: string; choices: MenuChoice[] };

/**
 * A row whose answer is picked from the platform's own menu, as Custom rules' rules are: the row states
 * the current answer, and pressing it opens the menu. With nothing to pick, or while `disabled`, it is a
 * plain row that opens nothing.
 */
export function MenuRow({
  icon,
  title,
  description,
  menuTitle,
  groups,
  onPick,
  disabled,
}: {
  icon?: TablerIcon;
  title: string;
  description?: string;
  menuTitle?: string;
  groups: MenuGroup[];
  onPick: (id: string) => void;
  disabled?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const any = groups.some((group) => group.choices.length > 0);
  const editable = any && !disabled;
  const row = (
    <Row
      icon={icon}
      title={title}
      description={description}
      trailing={
        editable ? (
          <Icon icon={IconSelector} size={16} color="accent-muted" />
        ) : undefined
      }
    />
  );
  if (!editable) return row;
  const action = (choice: MenuChoice): MenuAction => ({
    id: choice.id,
    title: choice.title,
    state: choice.on ? "on" : "off",
    ...(choice.destructive ? { attributes: { destructive: true } } : {}),
  });
  const actions: MenuAction[] = groups.flatMap((group, index) =>
    group.title || groups.length > 1
      ? [
          {
            id: `group:${index}`,
            title: group.title ?? "",
            displayInline: true,
            subactions: group.choices.map(action),
          },
        ]
      : group.choices.map(action),
  );
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <MenuView
        title={menuTitle ?? title}
        actions={actions}
        onPressAction={({ nativeEvent }) => onPick(nativeEvent.event)}
      >
        <View
          // The menu sizes itself to its trigger, so the row says its own width to reach the card's edge.
          style={width ? { width } : undefined}
          accessible
          accessibilityRole="button"
          accessibilityLabel={description ? `${title}, ${description}` : title}
          accessibilityHint="Opens a menu to change it"
        >
          {row}
        </View>
      </MenuView>
    </View>
  );
}
