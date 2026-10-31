import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { HANDED_OVER } from "@/lib/copilot/markers";
import { saidItWentAhead, toolResultHeldBack } from "@/lib/plugins/tool-result";

/**
 * How a Bot handing work to another Bot reads in the transcript.
 *
 * RENDER ONLY. `message_bot` runs on the server, where the grant, the caps and the audit row are, so
 * nothing here registers a tool or decides anything. What it registers is a line, because a hop that
 * happens off-screen is the thing the issue asks to avoid: a conversation that quietly fans out to
 * four Bots and bills for all of them should say so while it is doing it.
 *
 * Without this the call still appears, as a generic tool call named `message_bot` with its arguments
 * as JSON. That is technically visible and practically not: the point is that a person can see their
 * Bot bringing in another one and read what it asked for.
 */
const parameters = z.object({
  bot: z.string().optional(),
  task: z.string().optional(),
  constraints: z.string().optional(),
  expecting: z.string().optional(),
});

/**
 * Whether the deployment refused the hop.
 *
 * The result is a sentence the Bot can say either way, because a refusal mid-run is an answer rather
 * than an exception. The transcript still has to tell the two apart: one is a Bot bringing in help,
 * the other is a boundary holding, and drawing them the same way would make a working cap look like
 * a working handoff.
 */
function refused(result: unknown): boolean {
  return !saidItWentAhead(result, HANDED_OVER);
}

export function HandoffTool() {
  useRenderTool({
    name: "message_bot",
    parameters,
    render: ({ parameters: given, result, status }) => {
      const asked = given?.bot?.trim();
      const running = status !== "complete" && result === undefined;
      /*
       * The person holding it back is neither a hand-off nor a boundary: declined on its card, or
       * not asked again because the same request still waits. Named for what it would have done.
       */
      const heldBack =
        typeof result === "string" ? toolResultHeldBack(result) : null;
      const label = heldBack
        ? asked
          ? `Ask ${asked}`
          : "Ask another Bot"
        : asked
          ? `Asked ${asked}`
          : "Asked another Bot";
      return (
        <ToolLine
          label={label}
          detail={given?.task}
          running={running}
          declined={heldBack === "declined"}
          notYet={heldBack === "alreadyWaiting"}
          refused={!running && !heldBack && refused(result)}
        >
          {/*
           * The parts, kept as parts. The asking model was made to name them so the receiving one
           * need not infer them, and a person reading the conversation gets the same benefit: what
           * was asked, what bounded it, and what was wanted back.
           */}
          <div className="space-y-1 text-sm">
            {given?.task ? <p>{given.task}</p> : null}
            {given?.constraints ? (
              <p className="text-muted-foreground">
                Constraints: {given.constraints}
              </p>
            ) : null}
            {given?.expecting ? (
              <p className="text-muted-foreground">
                Wanted back: {given.expecting}
              </p>
            ) : null}
            {/* Words written for the Bot about the person's decision stay out. */}
            {typeof result === "string" && !heldBack ? (
              <p className="text-muted-foreground">{result}</p>
            ) : null}
          </div>
        </ToolLine>
      );
    },
  });

  return null;
}
