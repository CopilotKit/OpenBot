import type { ReactNode } from "react";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { BotsPanel } from "@/components/app-sidebar/bots-panel";
import { ConversationsPanel } from "@/components/app-sidebar/conversations-panel";
import { ShellAccountMenu } from "@/components/layout/native-shell-account";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * A panel of the sidebar as a whole page, for the phone app's native shell, whose tabs are the
 * sidebar's sections: the same component OpenBot Desktop draws beside its strip, so the two never
 * drift apart. The sidebar's panels are drawn with its primitives, which read the sidebar's state, so
 * they get a provider here, as wide and as tall as the page. The rows are a thumb's height in the
 * shell (styles.css, `[data-slot="section-panel"]`).
 */
function ShellPanel({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider
      className="min-h-0 flex-1"
      style={{ "--sidebar-width": "100%" } as React.CSSProperties}
    >
      {children}
    </SidebarProvider>
  );
}

/**
 * The Chats tab: the sidebar's Conversations panel, with the account beside New conversation, the
 * one way to Settings and Sign out in the shell.
 */
export function ShellChats() {
  return (
    <ShellPanel>
      <ConversationsPanel accessory={<ShellAccountMenu />} saysLoadFailure />
    </ShellPanel>
  );
}

/**
 * The Bots tab: the sidebar's Bots panel, with the account beside New Bot, and New Bot's sheet,
 * which the panel's + opens at `/bots?new=true` as it does on Desktop.
 */
export function ShellBots({
  creating,
  onClose,
  onCreated,
}: {
  creating: boolean;
  onClose: () => void;
  onCreated: (agentId: string) => void;
}) {
  return (
    <ShellPanel>
      <BotsPanel accessory={<ShellAccountMenu />} />
      <NewBotSheet onClose={onClose} onCreated={onCreated} open={creating} />
    </ShellPanel>
  );
}
