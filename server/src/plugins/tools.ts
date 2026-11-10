import { DESTRUCTIVE_TOOL_NOTE } from "@openbot/shared/bot-prompt";
import {
  addressedTo,
  SHOW_APP_ACCESS_TOOL,
} from "@openbot/shared/connect-prompt";
import { RESEARCH_TOOLS, type ResearchRole } from "@openbot/shared/research";
import { type GrantedTool, parametersFor } from "@openbot/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { SEARCH_TOOLS, systemOf } from "../agents/tool-search";
import { ApprovalRefusedError } from "../approvals/types";
import type { AuditInitiator } from "../audit";
import { currentEdition } from "../edition";
import { markUntrusted } from "../untrusted-content";
import { withAccountArgument } from "./account-argument";
import type { AppAccess, AppAccessState } from "./app-access";
import {
  type CatalogueEntry,
  catalogueEntry,
  researchRoleFor,
} from "./catalogue";
import { appCallsOfRun, sameArguments } from "./run-calls";
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
  /**
   * Tools this run holds and is not shown until a search finds them. See `agents/tool-search.ts`.
   *
   * Counted per system rather than named, which is the point of holding them back: naming 239 Shopify
   * tools here would put back in the prompt what search took out of the tool list. Their system is
   * still listed as one this Bot reaches, so it is never told it holds nothing for an app it holds
   * hundreds of tools for.
   */
  waiting: ReadonlySet<string> = new Set(),
  /**
   * The apps this Bot holds, as they stand for the person this run is for (`appAccessForBot`).
   * Absent where nobody asked, which says nothing about apps; empty says the Bot has none.
   */
  apps?: readonly BotApp[],
  /**
   * Tools this Bot holds that this run was not offered, for an endpoint sent only what a run's
   * message needs (`selectTools`, `fitToolLimit`). Counted per system like `waiting`, and never
   * listed as callable: there is no search to find them on that path, only a later turn that needs
   * them. Without these a Bot offered Parallel's feedback tool and not its search said it could not
   * search and that an administrator could grant it.
   */
  later: ReadonlySet<string> = new Set(),
): string {
  /*
   * THE CARD TOOL IS NOT A SYSTEM. It is offered to every Bot so a missing app can be put in front of
   * the person with the step that fixes it, and it reaches nothing — listed beside the vendors it
   * would read as one more system this Bot "can reach directly, as the person asking". It is named
   * below instead, at exactly the sentences that used to end on "an administrator can grant it".
   */
  const showsCards = tools.some((tool) => tool.name === SHOW_APP_ACCESS_TOOL);
  const reaching = tools.filter((tool) => tool.name !== SHOW_APP_ACCESS_TOOL);
  if (
    reaching.length === 0 &&
    connectedButNotHeld.length === 0 &&
    !showsCards &&
    apps === undefined
  )
    return "";
  // A system is named by its app's own name where it is known: "Gmail", not `composio-gmail`.
  const nameOf = new Map(apps?.map((app) => [app.key, app.displayName]));
  const named = (system: string) => nameOf.get(system) ?? system;
  const personal = currentEdition() === "personal";

  /*
   * AN APP THE PERSON CANNOT USE YET IS NOT A SYSTEM THEY REACH. Its tools are still held, and its
   * standing is said once, beside its name, in the apps line.
   *
   * FOUND IN 1.0.0-rc.4. A Bot holding Gmail, which the person had never connected, was told
   * "Gmail (needs connecting)" and then, a line later, "You can reach these systems directly, as the
   * person asking, with their own access: - Gmail: GMAIL_SEND_EMAIL, ...". It believed the second
   * and told the person Gmail was ready to read and send their mail.
   */
  const notReady = new Set(
    apps?.filter((app) => app.state !== "ready").map((app) => app.key),
  );
  const heldSystems = new Set(reaching.map((tool) => systemOf(tool.name)));
  const callable = reaching.filter(
    (tool) => !notReady.has(systemOf(tool.name)),
  );

  const bySystem = new Map<string, string[]>();
  const waitingBySystem = new Map<string, number>();
  const laterBySystem = new Map<string, number>();
  for (const tool of callable) {
    // `mcp__server__tool`, which is the shape the model is offered.
    const system = systemOf(tool.name);
    const parts = tool.name.replace(/^mcp__/, "").split("__");
    const rest = parts.length > 1 ? parts.slice(1).join("__") : tool.name;
    if (!bySystem.has(system)) bySystem.set(system, []);
    if (waiting.has(tool.name))
      waitingBySystem.set(system, (waitingBySystem.get(system) ?? 0) + 1);
    else if (later.has(tool.name))
      laterBySystem.set(system, (laterBySystem.get(system) ?? 0) + 1);
    else bySystem.get(system)?.push(rest);
  }

  /*
   * ONE REASON PER APP. An app the apps line names already says where it stands; listed here too,
   * a Notion that needed connecting was also "connected elsewhere, not granted to me".
   */
  const missing = connectedButNotHeld.filter(
    (system) => !heldSystems.has(system) && !nameOf.has(system),
  );

  // Only what this run can call: a provider waiting for a later turn is not one it can use now.
  const research = researchProviders(
    callable.filter((tool) => !later.has(tool.name)),
  );

  return [
    ...appsGuidance(apps, waiting.size > 0, showsCards),
    ...(apps !== undefined && callable.length > 0 ? [""] : []),
    ...(callable.length > 0
      ? [
          "You can reach these systems directly, as the person asking, with their own access:",
        ]
      : []),
    ...[...bySystem.entries()].map(([system, names]) => {
      const more = waitingBySystem.get(system) ?? 0;
      const after = laterBySystem.get(system) ?? 0;
      const extra = names.length > 0 ? "more " : "";
      return `- ${named(system)}: ${[
        ...names,
        ...(more > 0
          ? [`${more} ${extra}tools you find with ${SEARCH_TOOLS}`]
          : []),
        ...(after > 0
          ? [`${after} ${extra}tools offered on a turn that needs them`]
          : []),
      ].join(", ")}`;
    }),
    ...(waiting.size > 0
      ? [
          `Some of these systems have more tools than fit in front of you at once. Find them with ${SEARCH_TOOLS}:`,
          "describe what you need in a few words, and the tools it returns can be called from your next step.",
          `Search before deciding a system cannot do something. Only when ${SEARCH_TOOLS} finds nothing that fits is a`,
          "tool missing.",
        ]
      : []),
    ...(callable.length > 0
      ? [
          "Use them for anything about those systems. Do not browse to one of their websites instead: your",
          "browser is signed in as nobody, so it sees less than these tools do and will meet a sign-in wall",
          "that connecting an account has already solved.",
          ...(laterBySystem.size > 0
            ? [
                "A tool offered on a turn that needs it is one you hold: never say you lack it or that it",
                "has to be granted.",
              ]
            : []),
          `If one of these systems is involved and no tool you hold covers the part you need${waiting.size > 0 ? ` (search with ${SEARCH_TOOLS} first)` : ""},`,
          personal
            ? "say so plainly and name the capability you would need. Every action an app here offers is already yours: never say one has to be added or granted, or that anybody else has to do it, because the person you work for is the only one here."
            : "that is a missing grant. Say so plainly, name the capability you would need, and say an administrator can grant it on that connector.",
          "Do not reach for the browser, do not ask the person to sign in, and do not ask them to fetch it",
          "for you.",
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
    /*
     * NOT IN THE PERSONAL EDITION, where every tool an app lists goes to every Bot: an app a Bot
     * holds nothing for there is one that has listed nothing, because the person has not connected
     * it. Said to be "connected" with an administrator to ask, a Bot sent the one person to an
     * administrator there is none of, about an app nobody had connected. The card line below names
     * it instead, with the step the card itself offers.
     */
    ...(missing.length > 0 && !personal
      ? [
          ...(callable.length > 0 ? [""] : []),
          `This deployment also connects to: ${missing.map(named).join(", ")}. You hold none of their tools.`,
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
          "Do not browse to its website: that is not the same thing, your browser is signed in as nobody,",
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
          ...(callable.length > 0 ||
          (missing.length > 0 && !personal) ||
          apps?.length
            ? [""]
            : []),
          `If the person needs a work app that is not named here at all${notNamedExamples(apps)}, call`,
          `${SHOW_APP_ACCESS_TOOL} with its name before saying you cannot reach it: the card tells them whether it`,
          personal
            ? "is connected and offers the step that connects it. Do not browse to its website instead."
            : "can be switched on and lets them ask an administrator. Do not browse to its website instead.",
        ]
      : []),
  ].join("\n");
}

/**
 * The apps this deployment really connects to, by server id, for `grantedToolGuidance`'s
 * `connectedButNotHeld`: the ones whose tools were listed.
 *
 * AN APP WITH NOTHING LISTED IS NOT CONNECTED. Its sign-in never finished (a first-party app with
 * only its OAuth client, and a connect error where its tools would be), so there is nothing a grant
 * could give. Named as one "this deployment also connects to", with an administrator to ask, it
 * read to a Bot as connected for everybody and missing only for itself.
 */
export function connectedSystems(
  servers: readonly { id: string; tools: readonly unknown[] }[],
): string[] {
  return servers
    .filter((server) => server.tools.length > 0)
    .map((server) => server.id);
}

/** One app a Bot holds, as it stands for one person. */
export type BotApp = Pick<
  AppAccess,
  "key" | "displayName" | "state" | "account"
>;

/** How each state is said beside an app's name. "ready" is said "connected" where an account is. */
const APP_STANDING: Record<AppAccessState, string> = {
  ready: "connected",
  not_connected: "needs connecting",
  reconnect: "needs reconnecting",
  shared_not_connected: "waiting for an administrator to connect it",
  shared_not_approved:
    "waiting for an administrator to approve it for this Bot",
  disabled: "switched off",
  not_granted: "not given to you",
  owner_grantable: "not given to you",
};

/** The personal edition has no administrator: the one person connects a shared account too. */
const PERSONAL_STANDING: Partial<Record<AppAccessState, string>> = {
  shared_not_connected: "needs connecting",
  shared_not_approved: "not approved for you",
};

/**
 * Which apps this Bot can use for this person, said by name before anything else about its tools.
 *
 * FOUND IN 1.0.0-rc.1. A new Bot holding Gmail, which the person had connected, told them it had no
 * email connected and offered to "check" their inbox; asked to check, it searched, found Gmail's
 * tools and said Gmail was connected and working. Its instructions named the app only by its server
 * id (`composio-gmail`), said nothing about whether the person had connected it, and ended by
 * giving Gmail as the example of an app "not named here at all". With an app's tools waiting
 * behind {@link SEARCH_TOOLS}, nothing in front of the model said Gmail at all.
 *
 * One line, named and not listed by tool, so it costs a few tokens however many tools an app has.
 */
function appsGuidance(
  apps: readonly BotApp[] | undefined,
  searching: boolean,
  showsCards: boolean,
): string[] {
  if (apps === undefined) return [];
  if (apps.length === 0)
    return ["You have no apps turned on for the person you are working with."];
  const personal = currentEdition() === "personal";
  const standing = (app: BotApp) =>
    app.state === "ready" && app.account === "deployment"
      ? "ready"
      : personal
        ? (PERSONAL_STANDING[app.state] ?? APP_STANDING[app.state])
        : APP_STANDING[app.state];
  const unconnected = apps.some(
    (app) => app.state === "not_connected" || app.state === "reconnect",
  );
  return [
    `You can use these apps for the person you are working with: ${apps
      .map((app) => `${app.displayName} (${standing(app)})`)
      .join(", ")}.`,
    `When a request involves one of them, use its tools${searching ? `, finding them with ${SEARCH_TOOLS} when they are not in front of you` : ""}.`,
    "Never tell the person you have no access to an app named here as connected or ready, and do not",
    "offer to check it: check it.",
    ...(unconnected && showsCards
      ? [
          `For one that needs connecting or reconnecting, call ${SHOW_APP_ACCESS_TOOL} with its name: the card`,
          "in front of the person offers Connect.",
        ]
      : []),
  ];
}

/** The examples of an app this Bot was not given, leaving out any it holds. */
function notNamedExamples(apps: readonly BotApp[] | undefined): string {
  const held = new Set(apps?.map((app) => app.displayName.toLowerCase()));
  const examples = ["Gmail", "Slack", "Salesforce"].filter(
    (name) => !held.has(name.toLowerCase()),
  );
  return examples.length > 0 ? ` (${examples.join(", ")})` : "";
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

  /*
   * WHICH ACCOUNTS THE PERSON HOLDS AT EACH APP, so a Bot holding Gmail tools knows there are two
   * mailboxes and what they are called. Asked about the person whose accounts the call opens, which
   * for a Team Bot is its owner. Only an app with more than one account changes a tool: the schema
   * gains an `account` argument listing them (see `./account-argument`), and the call path checks
   * whatever comes back against the same person's accounts.
   */
  const servers = [
    ...new Set(granted.tools.map((tool) => tool.ref.split("/")[0] ?? "")),
  ].filter(Boolean);
  const opensAsFor = new Map<string, string>();
  for (const tool of granted.tools) {
    opensAsFor.set(
      tool.ref,
      credentialActorFor ? await credentialActorFor(tool.ref) : actorId,
    );
  }
  const choicesByPerson = new Map<
    string,
    Awaited<ReturnType<PluginStore["accountChoicesForServers"]>>
  >();
  for (const person of new Set(opensAsFor.values())) {
    /*
     * A list that cannot be read leaves every tool as the app wrote it: the call still runs in the
     * person's default account, and nothing about which tools a Bot holds depends on this read.
     */
    let held: Awaited<ReturnType<PluginStore["accountChoicesForServers"]>>;
    try {
      held = await store.accountChoicesForServers(person, servers);
    } catch {
      held = new Map();
    }
    choicesByPerson.set(person, held);
  }
  const schemaFor = (tool: (typeof granted.tools)[number]) => {
    const server = tool.ref.split("/")[0] ?? "";
    const held = choicesByPerson
      .get(opensAsFor.get(tool.ref) ?? actorId)
      ?.get(server);
    return held
      ? withAccountArgument(tool.inputSchema, held.title, held.choices)
      : tool.inputSchema;
  };

  /*
   * This run's app calls, a few at a time, and a read asked twice answered once. One per call of this
   * function, which is one per run: a run builds its tools afresh (`loadTools` in copilot.ts), so
   * nothing is cached past the run it was read in. A subagent's tools are built inside its run's
   * and take that run's calls (`appCallsOfRun`). See `./run-calls`.
   */
  const calls = appCallsOfRun();

  return granted.tools.map((tool) => ({
    name: tool.toolName,
    ref: tool.ref,
    searchable: true as const,
    ...(tool.read ? { reads: true as const } : {}),
    initiator,
    // OpenBot always asks before a tool its app marks destructive, and the Bot is told so here, on
    // the tool, since its name needn't say it (ASKING_GUIDANCE names these words).
    description: tool.destructive
      ? [tool.description.trim(), DESTRUCTIVE_TOOL_NOTE]
          .filter(Boolean)
          .join("\n\n")
      : tool.description,
    parameters: parametersFor(schemaFor(tool)),
    execute: async (args: unknown) => {
      // The runtime hands through whatever the model produced. Anything that is not an object is
      // not a set of arguments, and the vendor should be the one to say so.
      const callArgs =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      // Only a read is answered again from earlier in the run: a write asked twice is done twice.
      const key = tool.read ? `${tool.ref} ${sameArguments(callArgs)}` : null;
      return calls.call(key, async () => {
        try {
          const result = await store.callTool({
            ref: tool.ref,
            args: callArgs,
            botId,
            actorId,
            ...(initiator ? { initiator } : {}),
            ...(credentialActorFor
              ? { credentialActorId: await credentialActorFor(tool.ref) }
              : {}),
          });
          return { text: vendorAnswer(result), reusable: !result.isError };
        } catch (error) {
          if (error instanceof HeadlessToolSuspension) throw error;
          return { text: failedCall(error, botId), reusable: false };
        }
      });
    },
  }));
}

/**
 * What a Bot is told about a call that did not come back with an answer: a refusal, or a failure.
 */
function failedCall(error: unknown, botId: string): string {
  if (
    error instanceof PluginRefusedError ||
    error instanceof ApprovalRefusedError
  ) {
    /*
     * A refusal that carries an app card names the Bot here, the one place both are known: in a
     * channel several Bots answer in, the card has to ask what the app is for this person on THIS
     * Bot, not on whichever one the surface happens to have declared.
     */
    return `${REFUSAL_MARKER} ${addressedTo(error.message, botId)}`;
  }
  /*
   * A contradiction in this deployment's own tables says nothing to a model.
   *
   * CRITERION. Nothing on the `isDeploymentFault` shelf may have its message relayed from here,
   * whatever it says.
   *
   * REASON. The branch below hands `error.message` to the model, which is right for a vendor's own
   * words — that is somebody else's software explaining itself, and the diagnosis is worth having.
   * These are not that. `ServerRowAmbiguousError` names two of our columns and tells the reader to
   * rename a row or correct its provenance: an instruction only an operator can carry out, arriving
   * in an end user's model context as the reason their tool failed, from which the model can only
   * invent something to tell them. The operator who can act on it is served on the admin surface
   * instead, where the refresh route now answers with the sentence in full.
   */
  if (isDeploymentFault(error)) return "That tool could not be called.";
  // A vendor that failed is not a refusal, and the difference matters to the person reading the
  // answer: one means "not allowed", the other means "it broke".
  return error instanceof Error
    ? `That tool could not be called: ${error.message}`
    : "That tool could not be called.";
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
    instructions: skill.instructions,
  }));
}
