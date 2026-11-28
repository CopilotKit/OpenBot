import { IconChevronLeft } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { nativeShell } from "@/lib/native-shell/shell";
import {
  currentTabRoot,
  goBackInShell,
} from "@/lib/native-shell/use-tab-navigation";

/**
 * Back, at the start of a conversation's header, inside the phone app's native shell only: the
 * current tab's stack popped once (`lib/native-shell/use-tab-navigation.ts`), so it returns to where
 * the conversation was opened from, the Chats list, a Bot's group or Home. Where the tab has nowhere
 * to go back to, its root. 44px, a thumb's size; the shell's tab bar stays the way between tabs.
 */
export function ShellBackButton() {
  const navigate = useNavigate();
  if (!nativeShell()) return null;
  return (
    <Button
      aria-label="Back"
      className="size-11"
      onClick={() => {
        if (!goBackInShell()) void navigate({ to: currentTabRoot() ?? "/" });
      }}
      size="icon"
      variant="ghost"
    >
      <IconChevronLeft className="size-5" />
    </Button>
  );
}
