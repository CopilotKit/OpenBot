import { IconButton } from "./components";
import { useDrawer } from "./drawer";
import { IconMenu2 } from "./icons";

/** The header's menu button on a section's screen, which opens the app's menu. */
export function MenuButton() {
  const { setOpen } = useDrawer();
  return (
    <IconButton
      icon={IconMenu2}
      label="Open menu"
      size="sm"
      onPress={() => setOpen(true)}
    />
  );
}
