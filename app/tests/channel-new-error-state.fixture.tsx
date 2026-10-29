import type { NewBotSheet } from "@/components/agents/new-bot-sheet";

export function SidebarToggleStub() {
  return <button type="button">Toggle sidebar</button>;
}

// Exercise the recipient picker's creation handoff without running the separate creation flow.
export function NewBotCreationStub({
  open,
  onClose,
  onCreated,
}: Parameters<typeof NewBotSheet>[0]) {
  return (
    <>
      {open ? (
        <div role="dialog" aria-label="New Bot">
          <button type="button" onClick={onClose}>
            Cancel creation
          </button>
          <button type="button" onClick={() => onCreated("created-bot")}>
            Finish creation
          </button>
        </div>
      ) : null}
    </>
  );
}
