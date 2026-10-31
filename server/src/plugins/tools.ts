import {
  addressedTo,
  SHOW_APP_ACCESS_TOOL,
} from "@openbot/shared/connect-prompt";
import { RESEARCH_TOOLS, type ResearchRole } from "@openbot/shared/research";
import { type GrantedTool, parametersFor } from "@openbot/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { ApprovalRefusedError } from "../approvals/types";
import type { AuditInitiator } from "../audit";
import { markUntrusted } from "../untrusted-content";
import {
  type CatalogueEntry,
  catalogueEntry,
  researchRoleFor,
} from "./catalogue";
import type { SelectableSkill } from "./selection";
import {
  isDeploymentFault,
  PluginRefusedError,
  type PluginStore,
} from "./store";

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

/**
 * What a model is told a vendor answered: its result as written, or its error named as one.
 *
 * `isError` used to be dropped, and it cost a diagnosis. Google refused the Drive MCP server with
 * `isError: true` and the text "The caller does not have permission"; the model received that as an
 * ordinary result, believed it, and told the person it had no access to their Drive — which read as
 * the Bot being confused rather than as the vendor refusing.
 *
 * The prefix is the vendor's, and says so. It is deliberately NOT `REFUSAL_MARKER`: that one means
 * this deployment declined, and the transcript draws it as a boundary holding. A vendor saying no is
 * a different fact with a different fix, and collapsing the two would make a misconfigured connector
 * look like a policy working correctly.
 *
 * One function for both doors to one store — {@link grantedTools} for a Bot running here, and
 * `/api/agent-tools/call` for a Bot running its own loop — because the second answered with the bare
 * text, and neither framework Bot words an `isError` answer on its way through. Which door a Bot
 * arrives at is a deployment topology decision, not a decision about what its model is told.
 */
export function vendorAnswer(result: { text: string; isError: boolean }) {
  /*
   * Marked as outside content either way. A vendor's answer is somebody else's data: an issue title,
   * an email body, a document, any of which can be written to read like an instruction. The error
   * text is the vendor's too. See untrusted-content.ts; the transcript unwraps the envelope to draw it.
   */
  return result.isError
    ? `The vendor reported an error:\n${markUntrusted(result.text, "connector error")}`
    : markUntrusted(result.text, "connector result");
}

/**
 * What this Bot holds, said in its instructions rather than left to be inferred from a tool list.
 *
 * A tool array tells a model a tool exists. It does not tell it that the tool is the right way to
 * reach that system, and it competes with a page of prose about the browser that every Bot is given
 * whether or not it has any connectors at all. The browser prose wins: it is emphatic, it is about
 * capability, and it used to say "never claim you cannot browse".
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
  /*
   * THE CARD TOOL IS NOT A SYSTEM. It is offered to every Bot so a missing app can be put in front of
   * the person with the step that fixes it, and it reaches nothing — listed beside the vendors it
   * would read as one more system this Bot "can reach directly, as the person asking". It is named
   * below instead, at exactly the sentences that used to end on "an administrator can grant it".
   */
  const showsCards = tools.some((tool) => tool.name === SHOW_APP_ACCESS_TOOL);
  const reaching = tools.filter((tool) => tool.name !== SHOW_APP_ACCESS_TOOL);
  if (reaching.length === 0 && connectedButNotHeld.length === 0 && !showsCards)
    return "";

  const bySystem = new Map<string, string[]>();
  for (const tool of reaching) {
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

  const research = researchProviders(reaching);

  return [
    ...(reaching.length > 0
      ? [
          "You can reach these systems directly, as the person asking, with their own access:",
        ]
      : []),
    ...[...bySystem.entries()].map(
      ([system, names]) => `- ${system}: ${names.join(", ")}`,
    ),
    ...(reaching.length > 0
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
    ...researchGuidance(research),
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
          ...(reaching.length > 0 ? [""] : []),
          `This deployment also connects to: ${missing.join(", ")}. You hold none of their tools.`,
          ...(showsCards
            ? [
                `If a question needs one of them, call ${SHOW_APP_ACCESS_TOOL} with its name: that puts a card in`,
                "front of the person saying you have not been granted it, with a button to ask an administrator",
                "for it. Then say so in a sentence; the card already carries the rest.",
              ]
            : [
                "If a question needs one of them, say plainly that you have not been granted it and that an",
                "administrator can grant it on that connector.",
              ]),
          "Do NOT browse to its website: that is not the same thing, your browser is signed in as nobody,",
          "and it will meet a sign-in wall that the connector exists to avoid. Do not ask the person to",
          "sign in there either.",
        ]
      : []),
    /*
     * AN APP THIS DEPLOYMENT DOES NOT CONNECT AT ALL is the one case nothing above names, and the
     * one a Bot met most bluntly: asked about Gmail on a deployment that has not switched it on, it
     * had no word for Gmail anywhere in its instructions and either browsed or said it could not.
     * The card says whether it can be switched on and lets the person ask for it.
     */
    ...(showsCards
      ? [
          ...(reaching.length > 0 || missing.length > 0 ? [""] : []),
          `If the person needs a work app that is not named here at all (Gmail, Slack, Salesforce), call`,
          `${SHOW_APP_ACCESS_TOOL} with its name before saying you cannot reach it: the card tells them whether it`,
          "can be switched on and lets them ask an administrator. Do not browse to its website instead.",
        ]
      : []),
  ].join("\n");
}

type ResearchProvider = {
  entry: CatalogueEntry;
  search: GrantedTool;
  fetch: GrantedTool;
};

/**
 * Whether these tools include one that finds sources, from any research provider.
 *
 * The search role alone, not the full pair `researchProviders` wants: a Bot holding a search tool and
 * no reader can still search, and telling it to drive its browser to a search engine instead would
 * be the very routing mistake this decides against. See `computerGuidance`.
 */
export function holdsWebSearch(tools: readonly GrantedTool[]): boolean {
  return tools.some((tool) => researchRoleFor(tool.ref) === "search");
}

/**
 * The research providers this Bot can actually use: a search tool and a fetch tool from one server.
 *
 * One per vendor. A deployment that added a vendor twice, once free and once with its key, has
 * granted the keyed one for its limits, so that is the one the Bot is told about.
 */
function researchProviders(tools: GrantedTool[]): ResearchProvider[] {
  const byServer = new Map<
    string,
    Partial<Record<ResearchRole, GrantedTool>>
  >();
  for (const tool of tools) {
    const role = researchRoleFor(tool.ref);
    if (!role) continue;
    const server = tool.ref.slice(0, tool.ref.indexOf("/"));
    byServer.set(server, { ...byServer.get(server), [role]: tool });
  }
  const byVendor = new Map<string, ResearchProvider>();
  for (const [server, held] of byServer) {
    const entry = catalogueEntry(server);
    if (!entry || !held.search || !held.fetch) continue;
    const provider = { entry, search: held.search, fetch: held.fetch };
    const existing = byVendor.get(entry.vendor);
    if (!existing || entry.auth.kind === "deployment-bearer")
      byVendor.set(entry.vendor, provider);
  }
  return [...byVendor.values()];
}

/**
 * What a Bot is told about public-web research, the same for every provider.
 *
 * Described, not preferred: a Bot holding one of these and some other search tool is not told to
 * pass the other over. With more than one, the person's choice decides.
 *
 * Told to search unprompted for facts that change, because a Bot holding these answered "top five
 * countries by GDP" from memory and then, asked, said it could search. The bound in the next line
 * is what keeps that from becoming the open-web hunt the provenance guidance warns about.
 */
function researchGuidance(providers: ResearchProvider[]): string[] {
  if (providers.length === 0) return [];
  return [
    "For public-web research you can use:",
    ...providers.map(
      ({ entry, search, fetch }) =>
        `- ${entry.vendor}: ${search.name} finds sources and ${fetch.name} reads selected pages.`,
    ),
    ...(providers.length > 1
      ? [
          "Use the one the person asks for. Otherwise pick one and keep to it for the conversation.",
        ]
      : []),
    "Search before answering when the answer depends on facts that change: current figures, rankings, prices, who holds a role, recent events. Do not answer those from memory while you hold these tools, even when the person did not ask you to search.",
    "Keep it bounded: a search or two and a read of the best sources, then answer, and say what you could not confirm.",
    "These search the public web; they do not connect a person's private account. Send only the research objective, necessary search queries and requested URLs, not a full transcript or private documents.",
    ...providers.flatMap(({ entry }) =>
      (RESEARCH_TOOLS[entry.key]?.notes ?? []).map(
        (note) => `${entry.vendor}: ${note}`,
      ),
    ),
    "Do not name the provider in your answer unless the person asks which one you used: cite the sources you read.",
    "Cite source URLs and distinguish excerpts from full-page reads. Report provider errors or missing sources; do not invent evidence or quietly bypass a denial. Interactive browser work still uses the authorized computer tools when needed.",
  ];
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
  initiator?: AuditInitiator;
  /** Whose account a call reaches, when not the asker's; see `callTool`'s `credentialActorId`. */
  credentialActorFor?: (ref: string) => Promise<string>;
}): Promise<GrantedTool[]> {
  const { store, botId, actorId, initiator, credentialActorFor } = options;
  const granted = await store.listForAgent(botId);

  return granted.tools.map((tool) => ({
    name: tool.toolName,
    ref: tool.ref,
    initiator,
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
          ...(initiator ? { initiator } : {}),
          ...(credentialActorFor
            ? { credentialActorId: await credentialActorFor(tool.ref) }
            : {}),
        });
        return vendorAnswer(result);
      } catch (error) {
        if (error instanceof HeadlessToolSuspension) throw error;
        if (
          error instanceof PluginRefusedError ||
          error instanceof ApprovalRefusedError
        ) {
          /*
           * A refusal that carries an app card names the Bot here, the one place both are known:
           * in a channel several Bots answer in, the card has to ask what the app is for this
           * person on THIS Bot, not on whichever one the surface happens to have declared.
           */
          return `${REFUSAL_MARKER} ${addressedTo(error.message, botId)}`;
        }
        /*
         * A contradiction in this deployment's own tables says nothing to a model.
         *
         * CRITERION. Nothing on the `isDeploymentFault` shelf may have its message relayed from
         * here, whatever it says.
         *
         * REASON. The branch below hands `error.message` to the model, which is right for a
         * vendor's own words — that is somebody else's software explaining itself, and the
         * diagnosis is worth having. These are not that. `ServerRowAmbiguousError` names two of
         * our columns and tells the reader to rename a row or correct its provenance: an
         * instruction only an operator can carry out, arriving in an end user's model context as
         * the reason their tool failed, from which the model can only invent something to tell
         * them. The operator who can act on it is served on the admin surface instead, where the
         * refresh route now answers with the sentence in full.
         */
        if (isDeploymentFault(error)) return "That tool could not be called.";
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
