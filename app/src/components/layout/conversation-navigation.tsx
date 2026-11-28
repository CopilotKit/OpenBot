import { IconArrowLeft, IconChevronLeft } from "@tabler/icons-react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { conversationParent } from "@/lib/native-shell/conversation-navigation";
import { nativeShell } from "@/lib/native-shell/shell";
import { SidebarToggle } from "./sidebar-toggle";

/** A detail view has a way back even while the software keyboard covers the tab bar. */
export function ConversationNavigation({ className }: { className?: string }) {
  const shell = nativeShell();
  return shell ? (
    <ConversationBack android={shell.platform === "android"} />
  ) : (
    <SidebarToggle className={className} />
  );
}

function ConversationBack({ android }: { android: boolean }) {
  const router = useRouter();
  const location = useLocation();
  const parent = conversationParent(router.history, location);
  const Icon = android ? IconArrowLeft : IconChevronLeft;
  return (
    <Button
      aria-label={`Back to ${parent.label}`}
      className="size-11 shrink-0"
      onClick={() => {
        const index = location.state.__TSR_index;
        if (parent.index !== undefined && parent.index < index) {
          router.history.go(parent.index - index);
        } else {
          void router.navigate({ to: parent.path, replace: true });
        }
      }}
      size="icon"
      variant="ghost"
    >
      <Icon aria-hidden="true" className="rtl:rotate-180" />
    </Button>
  );
}
