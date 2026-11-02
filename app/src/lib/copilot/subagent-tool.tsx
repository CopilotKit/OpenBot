import { useRenderTool } from "@copilotkit/react-core/v2";
import { SUBAGENT_TOOL } from "@openbot/shared/subagent";
import { useContext } from "react";
import { z } from "zod";
import { SubagentCard } from "@/components/channels/subagent-card";
import { TurnInFlightContext } from "@/components/gallery/streaming";

/**
 * How a Bot giving part of its work to a subagent reads in the conversation.
 *
 * RENDER ONLY. `run_subagent` runs on the server, for built-in and remote Bots alike, so nothing here
 * registers a tool or decides anything. Without this the call would fold into "Used 4 tools", and a
 * Bot working on four things at once would look like it was doing nothing for a minute.
 */
const parameters = z.object({
  task: z.string().optional(),
  answer: z.string().optional(),
});

/**
 * Running while its turn is, whichever row it is: several start together and later ones arrive under
 * them. A call left without a result by a stopped turn has stopped.
 */
function Subtask(props: {
  toolCallId: string;
  task: string | undefined;
  result: string | undefined;
}) {
  return <SubagentCard {...props} running={useContext(TurnInFlightContext)} />;
}

export function SubagentTool() {
  useRenderTool({
    name: SUBAGENT_TOOL,
    parameters,
    render: ({ toolCallId, parameters: given, result }) => (
      <Subtask result={result} task={given?.task} toolCallId={toolCallId} />
    ),
  });

  return null;
}
