import { z } from "zod";
import type { SelectableSkill } from "./selection";
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
  /**
   * `<serverId>/<toolName>`, carried alongside the name the model is offered.
   *
   * The two spellings exist because a model tool name may not contain a slash, and selection has to
   * compare a tool against what a skill declared, which is written in the ref spelling because that
   * is how a grant is written. Carried rather than derived at the comparison, so there is one place
   * the two forms are converted (`toolNameFor`) and no second parser to drift from it.
   */
  ref: string;
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
 * What this Bot holds, said in its instructions rather than left to be inferred from a tool list.
 *
 * A tool array tells a model a tool exists. It does not tell it that the tool is the right way to
 * reach that system, and it competes with a page of prose about the browser that every Bot is given
 * whether or not it has any connectors at all. The browser prose wins: it is emphatic, it is about
 * capability, and it says "never claim you cannot browse".
 *
 * So a Bot holding four Google Drive tools browsed to drive.google.com, met a sign-in page its
 * container could never satisfy, and asked its person to sign in to a vendor that person had already
 * connected. The tools were there the whole time.
 *
 * Generated from the grants rather than written down, because the point is that it tracks them. An
 * administrator switching a connector on, or granting one more of its tools, changes what the Bot is
 * told on its next run with nothing else to remember and nothing to keep in step.
 *
 * Empty when the Bot holds nothing, so a deployment with no connectors says nothing about them.
 */
export function grantedToolGuidance(
  tools: GrantedTool[],
  /**
   * Systems this deployment connects to that this Bot holds nothing for.
   *
   * Without these a Bot holding no grants is told nothing at all, so it treats a connected vendor as
   * an ordinary website and browses to it. That is how a Bot with no Drive grant ended up on Google's
   * sign-in page asking a person to sign in to an account the deployment had already connected: the
   * connector existed, the Bot simply was not on it, and nothing said so.
   */
  connectedButNotHeld: readonly string[] = [],
): string {
  if (tools.length === 0 && connectedButNotHeld.length === 0) return "";

  const bySystem = new Map<string, string[]>();
  for (const tool of tools) {
    // `mcp__server__tool`, which is the shape the model is offered.
    const parts = tool.name.replace(/^mcp__/, "").split("__");
    const system = parts.length > 1 ? (parts[0] as string) : "this deployment";
    const rest = parts.length > 1 ? parts.slice(1).join("__") : tool.name;
    bySystem.set(system, [...(bySystem.get(system) ?? []), rest]);
  }

  const held = [...bySystem.keys()];
  const missing = connectedButNotHeld.filter(
    (system) => !held.includes(system),
  );

  return [
    ...(tools.length > 0
      ? [
          "You can reach these systems directly, as the person asking, with their own access:",
        ]
      : []),
    ...[...bySystem.entries()].map(
      ([system, names]) => `- ${system}: ${names.join(", ")}`,
    ),
    ...(tools.length > 0
      ? [
          "Use them for anything about those systems. Do NOT browse to one of their websites instead: your",
          "browser is signed in as nobody, so it sees less than these tools do and will meet a sign-in wall",
          "that connecting an account has already solved.",
          "If one of these systems is involved and no tool above covers the part you need, that is a",
          "missing grant and not something to work around. Say so plainly, name the capability you would",
          "need, and say an administrator can grant it on that connector. Do not reach for the browser, do",
          "not ask the person to sign in, and do not ask them to fetch it for you: they already have the",
          "access, and the thing that is missing is yours, not theirs.",
        ]
      : []),
    /*
     * The vendors this deployment connects to and this Bot does not hold.
     *
     * Named so the Bot can say which one, because "I have not been granted it" is only actionable if
     * the person is told what "it" is. The browser is refused for these by the same reasoning as
     * above and for a sharper reason: a connector exists precisely so the vendor is reached as the
     * person asking, and the container's browser is signed in as nobody, so browsing there abandons
     * the per-person path and lands on a login wall by construction.
     */
    ...(missing.length > 0
      ? [
          ...(tools.length > 0 ? [""] : []),
          `This deployment also connects to: ${missing.join(", ")}. You hold none of their tools.`,
          "If a question needs one of them, say plainly that you have not been granted it and that an",
          "administrator can grant it on that connector. Do NOT browse to its website: that is not the",
          "same thing, your browser is signed in as nobody, and it will meet a sign-in wall that the",
          "connector exists to avoid. Do not ask the person to sign in there either.",
        ]
      : []),
  ].join("\n");
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
    ref: tool.ref,
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

/**
 * The skills one Bot holds, as much of each as choosing between them needs.
 *
 * Read here rather than folded into `grantedTools` because the two answer different questions and
 * are wanted at different moments: the tools are what a Bot may call, asked once per request, and
 * the skills are the index a run is narrowed against. Both come from `listForAgent`, and both are
 * read fresh for the same reason: a grant added a minute ago has to count on the next run.
 */
export async function grantedSkills(options: {
  store: PluginStore;
  botId: string;
}): Promise<SelectableSkill[]> {
  const granted = await options.store.listForAgent(options.botId);
  return granted.skills.map((skill) => ({
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    tools: skill.tools,
  }));
}
