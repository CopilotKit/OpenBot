import { mock } from "bun:test";
import type { ReactNode } from "react";

mock.module("@/components/channels/conversation-view", () => ({
  ConversationView: ({
    disabled,
    notice,
  }: {
    disabled?: boolean;
    notice?: ReactNode;
  }) => (
    <div>
      <div
        data-disabled={String(Boolean(disabled))}
        data-testid="conversation-view"
      />
      {notice}
    </div>
  ),
}));

mock.module("@/components/layout/sidebar-toggle", () => ({
  SidebarToggle: () => <button type="button">Toggle sidebar</button>,
}));

mock.module("@/lib/channels/start", () => ({
  useStartChannel: () => ({
    pending: false,
    startChosen: async () => undefined,
  }),
}));

mock.module("@/lib/plugins/skill-commands", () => ({
  useSkillCommands: () => [],
}));
