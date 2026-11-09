/**
 * What an approval rule can name: every tool the approval gate is asked about, the kinds of action
 * each reaches it with, the targets it is asked about, and the Bots. Read from this OpenBot's own
 * apps and Bots, so a rule written from a description names tools that exist here, and a rule that
 * names one that does not is caught before anybody saves it.
 *
 * Each entry is the candidate the gate builds, as the code that asks builds it:
 * - an app's tool: `<app id>/<tool>`, effect `read` or `write` as `classifyTool` decides it, target
 *   the app's id (`plugins/plugin-store/calls.ts`);
 * - a computer's tool: the tool's name, effect `write` for activating, typing, saving a file and
 *   running a command, `read` for everything else, target the page's host, the file's folder or
 *   `workspace` (`computer/gateway.ts`);
 * - a folder on the person's own computer: `host/<kind>`, target the shared folder
 *   (`host-access/broker.ts`);
 * - asking another Bot: `bot/message_bot`, effect `delegate`, target the Bot asked
 *   (`agents/handoff-tool.ts`);
 * - sharing private information in a conversation: `openbot/share_private_information`
 *   (`proactive/private-share.ts`).
 *
 * `server/tests/approval-rule-translate.test.ts` holds the fixed entries against the code they come
 * from, so the writer is never told about a tool or an effect the gate would not see.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import { mcpServers, mcpTools } from "../db/schema/plugins";
import { catalogueEntry, classifyTool } from "../plugins/catalogue";

export type RuleVocabulary = {
  /** The apps set up in OpenBot, with every tool they list and the effect the gate sees for it. */
  apps: {
    id: string;
    title: string;
    tools: { name: string; effect: "read" | "write" }[];
  }[];
  /** Every Bot, by the id a rule names and the name a person knows it by. */
  bots: { id: string; name: string }[];
};

/** One tool the gate is asked about, with what a rule's other three patterns are matched against. */
export type VocabularyTool = {
  ref: string;
  effects: readonly string[];
  /**
   * The targets the gate is asked about for it. An app's tool always has its app's id; a computer,
   * a folder or a hand-off has one per page, folder or Bot, which nothing here can list.
   */
  scope: { kind: "app"; app: string } | { kind: "open" };
  /** What the tool is, for the writer and the reader. */
  about: string;
};

/** The computer's governed tools and the effect each one reaches the approval gate with. */
export const COMPUTER_APPROVAL_TOOLS: readonly {
  ref: string;
  effects: readonly ("read" | "write")[];
  about: string;
}[] = [
  { ref: "computer_navigate", effects: ["read"], about: "open a page" },
  { ref: "computer_click", effects: ["write"], about: "click on a page" },
  {
    ref: "computer_type",
    effects: ["write"],
    about: "type into a field on a page",
  },
  { ref: "computer_key", effects: ["write"], about: "press a key on a page" },
  { ref: "computer_scroll", effects: ["read"], about: "scroll a page" },
  {
    ref: "computer_read_file",
    effects: ["read"],
    about: "read a file in the Bot's workspace",
  },
  {
    ref: "computer_download_file",
    effects: ["read"],
    about: "download a file",
  },
  {
    ref: "computer_write_file",
    effects: ["write"],
    about: "save a file in the Bot's workspace",
  },
  {
    ref: "computer_list_files",
    effects: ["read"],
    about: "list the Bot's workspace",
  },
  {
    ref: "computer_run_command",
    effects: ["write"],
    about: "run a shell command in the Bot's workspace",
  },
];

/** A folder on the person's own computer, shared with OpenBot Desktop. */
export const HOST_APPROVAL_TOOLS: readonly {
  ref: string;
  effects: readonly ("read" | "write")[];
  about: string;
}[] = [
  {
    ref: "host/list_files",
    effects: ["read"],
    about: "list a folder on the person's own computer",
  },
  {
    ref: "host/read_file",
    effects: ["read"],
    about: "read a file in a folder on the person's own computer",
  },
  {
    ref: "host/write_file",
    effects: ["write"],
    about: "save a file in a folder on the person's own computer",
  },
  {
    ref: "host/run_command",
    effects: ["write"],
    about: "run a command on the person's own computer",
  },
];

export const HANDOFF_APPROVAL_TOOL = {
  ref: "bot/message_bot",
  effects: ["delegate"],
  about: "hand work to another Bot; the target is the Bot asked",
} as const;

export const PRIVATE_SHARE_APPROVAL_TOOL = {
  ref: "openbot/share_private_information",
  effects: ["share_private"],
  about:
    "share the person's private information in a conversation other people read",
} as const;

/** Every tool a rule can name, the apps' and OpenBot's own. */
export function vocabularyTools(vocabulary: RuleVocabulary): VocabularyTool[] {
  return [
    ...vocabulary.apps.flatMap((app) =>
      app.tools.map(
        (tool): VocabularyTool => ({
          ref: `${app.id}/${tool.name}`,
          effects: [tool.effect],
          scope: { kind: "app", app: app.id },
          about: `${app.title}: ${tool.name}`,
        }),
      ),
    ),
    ...[
      ...COMPUTER_APPROVAL_TOOLS,
      ...HOST_APPROVAL_TOOLS,
      HANDOFF_APPROVAL_TOOL,
      PRIVATE_SHARE_APPROVAL_TOOL,
    ].map(
      (tool): VocabularyTool => ({
        ref: tool.ref,
        effects: tool.effects,
        scope: { kind: "open" },
        about: tool.about,
      }),
    ),
  ];
}

/** Tools listed per app in the writer's prompt. Past it the app's own name and a glob still work. */
const TOOLS_PER_APP = 150;

/** The vocabulary as the writer and the reader read it. */
export function vocabularyText(vocabulary: RuleVocabulary): string {
  const builtIn = [
    ...COMPUTER_APPROVAL_TOOLS,
    ...HOST_APPROVAL_TOOLS,
    HANDOFF_APPROVAL_TOOL,
    PRIVATE_SHARE_APPROVAL_TOOL,
  ];
  return [
    "APPS SET UP IN OPENBOT. A tool is <app id>/<tool name>, and its target is the app id. Effect after each tool. An app not listed here is not set up, and no rule can name it.",
    ...(vocabulary.apps.length === 0
      ? ["(none)"]
      : vocabulary.apps.flatMap((app) => [
          `- ${app.id} (${app.title}), ${app.tools.length} tools:`,
          ...app.tools
            .slice(0, TOOLS_PER_APP)
            .map((tool) => `    ${tool.name} [${tool.effect}]`),
          ...(app.tools.length > TOOLS_PER_APP
            ? [`    and ${app.tools.length - TOOLS_PER_APP} more`]
            : []),
        ])),
    "",
    "OPENBOT'S OWN TOOLS. Effect in brackets.",
    ...builtIn.map(
      (tool) => `- ${tool.ref} [${tool.effects.join(", ")}]: ${tool.about}`,
    ),
    "A computer tool's target is the page's host (www.example.com), the file's folder (reports), \"workspace\" for a command, or \"browser\" with no page. A folder tool's target is the shared folder. A hand-off's target is the name of the Bot asked.",
    "",
    "BOTS. botId is the id before the colon.",
    ...(vocabulary.bots.length === 0
      ? ["(none)"]
      : vocabulary.bots.map((bot) => `- ${bot.id}: ${bot.name}`)),
  ].join("\n");
}

/**
 * This OpenBot's apps and Bots, from its own tables. An app's tools are the ones it listed, each
 * with the effect `classifyTool` gives it, which is the effect a call to it reaches the gate with.
 */
export async function loadRuleVocabulary(
  database: Database,
): Promise<RuleVocabulary> {
  const [servers, tools, bots] = await Promise.all([
    database
      .select({ id: mcpServers.id, title: mcpServers.title })
      .from(mcpServers)
      .orderBy(asc(mcpServers.id)),
    database
      .select({
        serverId: mcpTools.serverId,
        name: mcpTools.name,
        effect: mcpTools.effect,
      })
      .from(mcpTools)
      .orderBy(asc(mcpTools.serverId), asc(mcpTools.name)),
    database
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .innerJoin(
        agentProfiles,
        and(
          eq(agentProfiles.agentId, agents.id),
          isNull(agentProfiles.deletedAt),
        ),
      )
      .orderBy(asc(agents.name)),
  ]);
  return {
    apps: servers.map((server) => {
      const entry = catalogueEntry(server.id);
      return {
        id: server.id,
        title: server.title,
        tools: tools
          .filter((tool) => tool.serverId === server.id)
          .map((tool) => ({
            name: tool.name,
            effect: classifyTool(entry, tool.name, true, tool.effect),
          })),
      };
    }),
    bots,
  };
}
