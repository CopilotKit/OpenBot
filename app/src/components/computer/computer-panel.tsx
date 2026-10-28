import type { Ref } from "react";
import {
  ConversationOrb,
  useConversationStatus,
} from "@/components/channels/conversation-presence";
import { ComputerView, type ComputerViewHandle } from "./computer-view";
import { StepLog } from "./step-log";

/** The current live computer, separate from screenshots kept in historical tool results. */
export function ComputerViewPanel({
  agentId,
  name,
  wheelInHeader = false,
  screen,
}: {
  agentId: string;
  name?: string;
  /** Take control is in the pane's header, which opens the screen full size through `screen`. */
  wheelInHeader?: boolean;
  screen?: Ref<ComputerViewHandle>;
}) {
  return (
    <section aria-label="Computer sidebar" className="p-4">
      <ComputerView
        active
        computerId={agentId}
        minWidth={0}
        name={name}
        ref={screen}
        wheelInHeader={wheelInHeader}
      />
      <div className="mt-8">
        <h3 className="mb-2 font-medium text-sm">Activity</h3>
        <StepLog computerId={agentId} />
      </div>
    </section>
  );
}

/** Small enough for the pane's 48px header, so it blinks and watches and otherwise keeps still. */
const TITLE_ORB_SIZE = 28;

/**
 * The computer pane's title: the Bot's orb, in the state its conversation is in, whose computer this
 * is, and a dot while the conversation needs the person. "Computer" until the Bot's name arrives.
 *
 * The title alone, which the skins dress as the pane's tab. Take control sits beside it, in the
 * header's actions.
 */
export function ComputerPaneTitle({
  agentId,
  name,
}: {
  agentId: string;
  name: string | undefined;
}) {
  const needsYou = useConversationStatus().kind === "needs-you";
  return (
    <>
      <ConversationOrb participantIds={[agentId]} size={TITLE_ORB_SIZE} />
      <span className="type-sub min-w-0 truncate pl-1 font-medium">
        {name ? `${name}'s computer` : "Computer"}
      </span>
      {needsYou ? (
        <span
          aria-label="Needs you"
          className="size-2 shrink-0 rounded-full bg-status-needs"
          role="img"
        />
      ) : null}
    </>
  );
}
