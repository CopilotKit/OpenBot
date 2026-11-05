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
  parts: z
    .array(
      z.object({
        header: z.string().optional(),
        question: z.string().optional(),
        options: z.array(z.string()).optional(),
      }),
    )
    .optional(),
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
            {/*
             * Numbered when there are several, so "the second one" means something. One decision
             * is just the question, and a list of one numbered "1." reads as if more were missing.
             */}
            {given?.parts?.length ? (
              <ol
                className={
                  given.parts.length > 1
                    ? "list-decimal space-y-0.5 pl-5"
                    : "list-none"
                }
              >
                {given.parts.map((part, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the parts arrive as one list and never reorder
                  <li key={index}>
                    {part.header ? (
                      <span className="font-medium">{part.header}: </span>
                    ) : null}
                    {part.question}
                    {part.options?.length ? (
                      <span className="text-muted-foreground">
                        {" "}
                        ({part.options.join(", ")})
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </ToolLine>
      );
    },
  });

  return null;
}
