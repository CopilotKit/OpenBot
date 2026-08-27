import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { PUT_TO } from "@/lib/copilot/markers";
import { saidItWentAhead } from "@/lib/plugins/tool-result";

/**
 * How a Bot stopping to ask a person reads in the transcript.
 *
 * RENDER ONLY, for the same reason as the handoff beside it: `ask_person` runs on the server, where
 * the route and the audit row are. What this adds is that the choice is legible. A Bot which decided
 * it could not settle something on its own, and said so rather than guessing, has done the right
 * thing; drawn as a raw `ask_person` call with its arguments as JSON it reads as a malfunction.
 */
const parameters = z.object({
  question: z.string().optional(),
  why: z.string().optional(),
});

/**
 * Whether the question reached anybody.
 *
 * Decoded first, because a server-side tool's result arrives as a JSON-encoded string and a prefix
 * matched against the raw value never matches: that mistake drew every successful handoff as
 * Blocked. A route that could not reach a person is the case worth drawing differently, because the
 * Bot has stopped and nobody has been asked.
 */
function reached(result: unknown): boolean {
  return saidItWentAhead(result, PUT_TO);
}

export function EscalationTool() {
  useRenderTool({
    name: "ask_person",
    parameters,
    render: ({ parameters: given, result, status }) => {
      const running = status !== "complete" && result === undefined;
      return (
        <ToolLine
          label="Asked you"
          detail={given?.question}
          running={running}
          refused={!running && !reached(result)}
        >
          <div className="space-y-1 text-sm">
            {given?.question ? <p>{given.question}</p> : null}
            {/*
             * Why it stopped, which is the half a person is owed. "I need a decision only you can
             * make" and "I could not find the answer" look the same from the outside and are not.
             */}
            {given?.why ? (
              <p className="text-muted-foreground">{given.why}</p>
            ) : null}
          </div>
        </ToolLine>
      );
    },
  });

  return null;
}
