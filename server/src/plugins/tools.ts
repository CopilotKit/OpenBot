import { z } from "zod";
import { PluginRefusedError, type PluginStore } from "./store";

/**
 * The tools a Bot may call, as the runtime's own tool definitions, executed on the server.
 *
 * The loop used to run in the browser: every MCP tool was registered with `useFrontendTool` and its
 * handler posted back to `/api/plugins/call`. That made a browser a hard requirement for a Bot to do
 * anything, which rules out an embedded widget, a run nobody is watching, and any surface that is
 * not our own app.
 *
 * Nothing about governance moves with it. `callTool` is still the only path to a vendor: it checks
 * the grant, evaluates the policy, writes the audit row, and only then calls out. This module hands
 * the model a description of what it may call; the store remains what decides whether a call happens.
 *
 * Read at run time rather than captured, so a grant an administrator adds or revokes applies to the
 * next run rather than after a restart.
 */
/**
 * What a refused call answers with.
 *
 * The transcript draws a refusal differently from a result, and it has only the tool's answer to go
 * on. Guessing from the wording would break the first time an administrator rephrased a policy
 * message, so the answer says which it is. The model reads this too, and "Refused." in front of a
 * reason is what it should be told anyway.
 */
export const REFUSAL_MARKER = "Refused.";

export type GrantedTool = {
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (args: unknown) => Promise<string>;
};

/**
 * A vendor's JSON Schema as something the model can be handed.
 *
 * Anything that is not an object schema describes something other than a tool's arguments, and a
 * schema we cannot read must not stop the tool being offered: an open object lets the model call it
 * and lets the vendor be the one to reject a bad argument, which is where that error belongs.
 */
export function parametersFor(inputSchema: Record<string, unknown>): z.ZodType {
  try {
    const converted = z.fromJSONSchema(inputSchema as never);
    if (converted instanceof z.ZodObject) return converted;
  } catch {}
  return z.object({}).catchall(z.unknown());
}

/**
 * Every MCP tool granted to one Bot, ready to hand to the runtime.
 *
 * A refusal is returned as the tool's result rather than thrown. The model is mid-run and the person
 * is owed a sentence about what was blocked; an exception here ends the run with nothing said, and
 * the refusal is already in the audit trail either way.
 */
export async function grantedTools(options: {
  store: PluginStore;
  botId: string;
  actorId: string;
}): Promise<GrantedTool[]> {
  const { store, botId, actorId } = options;
  const granted = await store.listForAgent(botId);

  return granted.tools.map((tool) => ({
    name: tool.toolName,
    description: tool.description,
    parameters: parametersFor(tool.inputSchema),
    execute: async (args: unknown) => {
      try {
        const result = await store.callTool({
          ref: tool.ref,
          // The runtime hands through whatever the model produced. Anything that is not an object
          // is not a set of arguments, and the vendor should be the one to say so.
          args:
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
          botId,
          actorId,
        });
        /*
         * A vendor's error is named as one, not handed over as content.
         *
         * `isError` used to be dropped here, and it cost a diagnosis. Google refused the Drive MCP
         * server with `isError: true` and the text "The caller does not have permission"; the model
         * received that as an ordinary result, believed it, and told the person it had no access to
         * their Drive — which read as the Bot being confused rather than as the vendor refusing.
         *
         * The prefix is the vendor's, and says so. It is deliberately NOT `REFUSAL_MARKER`: that one
         * means this deployment declined, and the transcript draws it as a boundary holding. A vendor
         * saying no is a different fact with a different fix, and collapsing the two would make a
         * misconfigured connector look like a policy working correctly.
         */
        return result.isError
          ? `The vendor reported an error: ${result.text}`
          : result.text;
      } catch (error) {
        if (error instanceof PluginRefusedError) {
          return `${REFUSAL_MARKER} ${error.message}`;
        }
        // A vendor that failed is not a refusal, and the difference matters to the person reading
        // the answer: one means "not allowed", the other means "it broke".
        return error instanceof Error
          ? `That tool could not be called: ${error.message}`
          : "That tool could not be called.";
      }
    },
  }));
}
