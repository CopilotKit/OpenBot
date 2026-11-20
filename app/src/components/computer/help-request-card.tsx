import type { HandoffStatus } from "@openbot/shared/computer-control";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconHandStop,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { useComputerControl } from "@/lib/computers/use-control";
import { useConversation } from "@/lib/copilot/conversation";
import { useToolPlace } from "@/lib/copilot/tool-place";
import { ComputerView } from "./computer-view";

/**
 * A BOT ASKING THE PERSON TO TAKE OVER ITS BROWSER (`computer_request_help`), drawn where it happened in the
 * conversation.
 *
 * While the request is open it is the Bot's screen itself, which already says what the Bot needs and holds the wheel,
 * so the person can take control from the conversation they are reading. Once it is answered it folds into one line
 * that says what the Bot asked for and what came of it: the step stays in the record after the screen has moved on.
 *
 * It drew nothing before. A Bot that asked without a word and then answered the hand-back with no words either left
 * a turn with nothing in it at all, and the person could not see that anything had happened.
 */

/** What the tool returned, as far as this card reads it. */
type HelpOutcome = {
  ok?: boolean;
  stopped?: boolean;
  handoffStatus?: HandoffStatus;
  reason?: string;
};

function outcomeOf(result: string | undefined): HelpOutcome | undefined {
  if (result === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(result);
    return parsed && typeof parsed === "object" ? (parsed as HelpOutcome) : {};
  } catch {
    // The runtime stringifies a handler that threw as "Error: <message>".
    return {
      ok: false,
      reason: result.startsWith("Error:")
        ? result.slice("Error:".length).trim()
        : result,
    };
  }
}

/** What happened to the request, in a few words, for each way it can end. */
function endedAs(outcome: HelpOutcome): {
  title: string;
  done: boolean;
  detail?: string;
} {
  if (outcome.handoffStatus === "completed")
    return { title: "Taken over and handed back", done: true };
  if (outcome.stopped) return { title: "Stopped waiting for you", done: false };
  switch (outcome.handoffStatus) {
    case "cancelled":
      return { title: "Nobody took over", done: false };
    case "expired":
      return { title: "Nobody took over in time", done: false };
    case "interrupted":
      return {
        title: "The computer stopped before this was done",
        done: false,
      };
    default:
      return {
        title: "Couldn't wait for you",
        done: false,
        ...(outcome.reason ? { detail: outcome.reason } : {}),
      };
  }
}

export function HelpRequestCard({
  botId,
  toolCallId,
  reason,
  result,
}: {
  botId: string;
  toolCallId: string | undefined;
  /** What the Bot asked for, in its own words. Absent while the call is still streaming in. */
  reason: string | undefined;
  result: string | undefined;
}) {
  const place = useToolPlace();
  const ask = useConversation()?.ask;
  const outcome = outcomeOf(result);
  const { control } = useComputerControl(botId, outcome === undefined);
  /*
   * Answered on the computer, and not here yet: the person handed back in a conversation they had left and come back
   * to, and the turn that took the answer is carrying on elsewhere in this tab. Said as done rather than drawn as a
   * screen still asking for them.
   */
  const handedBackHere =
    outcome === undefined &&
    toolCallId !== undefined &&
    control?.request?.toolCallId === toolCallId &&
    control.request.status === "completed";

  if (outcome === undefined && !handedBackHere)
    return (
      <div className="my-2" data-help-request={toolCallId}>
        <ComputerView
          computerId={botId}
          {...(toolCallId ? { toolCallId } : {})}
        />
      </div>
    );

  const ended = handedBackHere
    ? { title: "Taken over and handed back", done: true }
    : endedAs(outcome ?? {});
  /*
   * The Bot's turn ended on the hand-back without a word. Its tool result asks it to say what it does next, and it
   * usually does; when it does not, the conversation says so and offers the nudge, rather than showing a turn with
   * nothing after the step.
   */
  const silent =
    ended.done &&
    !handedBackHere &&
    place?.latest === true &&
    !place.spokeAfter &&
    ask !== undefined;
  const asked = reason?.trim();

  return (
    <Item
      size="sm"
      variant="outline"
      // Framed in both themes, as every card in a conversation is: a row's outline drops its border in dark.
      className="my-2 w-full max-w-2xl rounded-xl dark:border-border"
      data-help-request={toolCallId}
      role={silent ? "status" : undefined}
    >
      <ItemMedia variant="icon">
        {ended.done ? (
          <IconCircleCheck className="text-emerald-600 dark:text-emerald-400" />
        ) : (
          <IconAlertTriangle className="text-amber-600 dark:text-amber-400" />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none">{ended.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {asked ? (
            <>
              <IconHandStop
                aria-hidden="true"
                className="mr-1 inline size-3.5 align-[-2px]"
              />
              The Bot asked: “{asked}”
            </>
          ) : (
            "The Bot asked you to take over its browser."
          )}
          {ended.detail ? ` ${ended.detail}` : null}
          {handedBackHere ? " The Bot is carrying on." : null}
          {silent
            ? " The Bot stopped here without saying what it does next."
            : null}
        </ItemDescription>
      </ItemContent>
      {silent ? (
        <ItemActions>
          <Button onClick={() => ask?.("Please carry on.")} size="sm">
            Carry on
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
}
