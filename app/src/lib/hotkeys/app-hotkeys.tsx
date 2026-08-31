import { useNavigate } from "@tanstack/react-router";
import { useHotkey } from "./use-hotkey";

/**
 * The app-wide shortcuts, bound once for the whole signed-in app.
 *
 * Mounted in `_authed` rather than `_app`, so a person on settings or admin can start a chat
 * without first clicking back into the app frame. Renders nothing; it exists to be a component
 * because binding needs hooks and `_authed`'s route component is where the whole signed-in tree
 * hangs.
 */
export function AppHotkeys() {
  const navigate = useNavigate();

  // Same destination as the sidebar's + button: the new-channel composer.
  useHotkey("new-chat", () => {
    navigate({ to: "/channel/new" });
  });

  return null;
}
