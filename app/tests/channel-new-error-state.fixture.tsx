import { mock } from "bun:test";

mock.module("@/components/layout/sidebar-toggle", () => ({
  SidebarToggle: () => <button type="button">Toggle sidebar</button>,
}));

// Exercise the recipient picker's creation handoff without running the separate creation flow.
mock.module("@/components/agents/new-bot-sheet", () => ({
  NewBotSheet: ({
    open,
    onClose,
    onCreated,
  }: {
    open: boolean;
    onClose: () => void;
    onCreated: (id: string) => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="New Bot">
        <button type="button" onClick={onClose}>
          Cancel creation
        </button>
        <button type="button" onClick={() => onCreated("created-bot")}>
          Finish creation
        </button>
      </div>
    ) : null,
}));
