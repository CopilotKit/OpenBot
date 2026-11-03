import type { BuiltInAgentClassicConfig } from "@copilotkit/runtime/v2";
import { MODEL_TOOL_LIMIT } from "@openbot/shared/model-tool-limit";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import { researchRoleFor } from "../plugins/catalogue";

/**
 * Letting a Bot hold hundreds of tools while its model is shown a few dozen, and find the rest when
 * it needs them.
 *
 * FOUND LIVE. Approving General Assistant's access to Shopify granted it 239 read-only actions in
 * one click, taking it to 279 tools, and every message after that failed. Every granted tool went to
 * the model on every call. Chat Completions refuses more than 128 tools outright; the Responses API
 * refused this set too, because its function tools are strict by default and OpenAI caps the
 * compiled size of all strict schemas in one request. Under both limits a long tool list still costs
 * context on every step and makes the model's choice worse.
 *
 * WHAT THIS DOES. Past {@link TOOL_SEARCH_FLOOR}, an app's tools (`GrantedTool.searchable`) wait
 * behind one ordinary tool, {@link SEARCH_TOOLS}. The model searches in a few words, the tools it is
 * shown become part of what it is sent from its next step on, and it calls them by their real names.
 * Everything a Bot needs to be itself stays in front of it on every step.
 *
 * THE GRANT IS STILL THE BOUNDARY, AND THIS IS NOT ONE. Every granted tool stays registered with the
 * runtime under its own name and executes through the plugin store's `callTool`: grant, then policy,
 * then audit row. What waits is what the model is SHOWN. A search ranks only what this Bot was
 * granted, so it cannot name anything else, and a call to a name the Bot was not granted has nothing
 * registered to run.
 *
 * WHY OUR OWN SEARCH AND NOT THE PROVIDER'S. OpenAI and Anthropic both offer a search the provider
 * runs (`tool_search`, `defer_loading`). Tried through the runtime, it worked for one turn and broke
 * every turn after: the runtime replays the provider's search as an ordinary tool call and result,
 * OpenAI refuses that history (`No tool call found for function call output`), and the person's
 * conversation is dead from its second message. It also exists only on the Responses API from
 * `gpt-5.4` on, never behind a gateway answering `/chat/completions`. An ordinary tool replays like
 * any other and works on every provider. The cost is one extra model step per search.
 *
 * NOT THE RETRIEVAL PREFILTER `plugins/selection.ts` REJECTS. That one decides before the model sees
 * anything, and a tool it drops is gone for the run. Here the model asks, reads what came back, and
 * can ask again in other words, so a poor first search costs a step and not the answer.
 */

/** The name the model calls to find a tool it holds but has not been shown. */
export const SEARCH_TOOLS = "search_tools";

/**
 * At or under this many tools, a run is sent all of them, exactly as it was before search existed.
 *
 * Fifty because tool choice is reported to degrade past thirty to fifty tools (Anthropic's tool
 * search guide), a Bot's own tools already take fifteen or twenty of those, and every Bot that works
 * today should keep working the same way. Above it, searching costs a step and saves the run.
 */
export const TOOL_SEARCH_FLOOR = 50;

/** How many tools one search returns unless the model asks for another number. */
const SEARCH_RESULTS = 8;

/** Reserve enough room to load even the largest search response. */
export const SEARCH_RESULTS_LIMIT = 20;

// Use the model contract of the runtime we actually ship, without a second AI SDK version.
type SearchingModel = Extract<
  BuiltInAgentClassicConfig["model"],
  { specificationVersion: "v3" }
>;
type CallOptions = Parameters<SearchingModel["doStream"]>[0];
type ModelTool = NonNullable<CallOptions["tools"]>[number];
type Prompt = CallOptions["prompt"];
/** The fields of a prompt part this module reads, whichever role's message it sits in. */
type PromptPart = { type: string; toolName?: string; output?: unknown };

/**
 * Which of a run's tools wait behind {@link SEARCH_TOOLS}. Empty means the run is sent everything.
 *
 * Only an app's tools wait, and not every one of those: a tool that finds or reads sources on the
 * web stays, because the computer's instructions route searching to it and a Bot told to use a tool
 * it cannot see reaches for the browser instead. A tool the run's chosen skills asked for stays too,
 * unless even those leave the run over the floor, where a skill has asked for more than a model
 * chooses well among and they wait like the rest.
 */
export function planToolSearch(
  tools: readonly GrantedTool[],
  options: {
    /** Names `selectTools` chose for this run. Kept in front of the model when there is room. */
    pinned?: ReadonlySet<string>;
    /** Tools the run is sent that are not in `tools`: learned skills, the runtime's, the client's. */
    alsoSent?: number;
  } = {},
): ReadonlySet<string> {
  const total = tools.length + (options.alsoSent ?? 0);
  if (total <= TOOL_SEARCH_FLOOR) return new Set();
  const searchable = tools.filter(
    (tool) => tool.searchable && researchRoleFor(tool.ref) === null,
  );
  const pinned = options.pinned ?? new Set<string>();
  const unpinned = searchable.filter((tool) => !pinned.has(tool.name));
  const waiting =
    total - unpinned.length > TOOL_SEARCH_FLOOR ? searchable : unpinned;
  return new Set(waiting.map((tool) => tool.name));
}

/** Lower-cased words of a name, a description or a query, with plurals folded into the singular. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1)
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word,
    );
}

/** The argument names of a tool, which say what it acts on as often as its description does. */
function argumentNames(tool: GrantedTool): string[] {
  try {
    const schema = z.toJSONSchema(tool.parameters, { unrepresentable: "any" });
    const properties = (schema as { properties?: Record<string, unknown> })
      .properties;
    return properties ? Object.keys(properties) : [];
  } catch {
    return [];
  }
}

type Indexed = {
  tool: GrantedTool;
  name: Set<string>;
  rest: Set<string>;
};

/**
 * The tools that best match a query, best first.
 *
 * Words in a tool's name count three times as much as words in its description or argument names,
 * because an app names its tools after what they do (`SHOPIFY_LIST_ORDERS`) and describes them in
 * prose that mentions everything nearby. Rare words count for more than common ones, so "orders"
 * separates Shopify's tools where "shopify" cannot. No match at all returns nothing, and the model
 * is told so rather than handed the nearest unrelated tools.
 */
export function rankTools(
  query: string,
  tools: readonly GrantedTool[],
  limit = SEARCH_RESULTS,
): GrantedTool[] {
  return rankIndexed(query, tools.map(indexed), limit);
}

function indexed(tool: GrantedTool): Indexed {
  return {
    tool,
    name: new Set(words(tool.name)),
    rest: new Set([
      ...words(tool.description),
      ...argumentNames(tool).flatMap(words),
    ]),
  };
}

function rankIndexed(
  query: string,
  index: readonly Indexed[],
  limit: number,
): GrantedTool[] {
  const asked = [...new Set(words(query))];
  if (asked.length === 0) return [];
  const rarity = new Map(
    asked.map((word) => {
      const holding = index.filter(
        (entry) => entry.name.has(word) || entry.rest.has(word),
      ).length;
      return [word, Math.log(1 + index.length / (1 + holding))];
    }),
  );
  return index
    .map((entry) => ({
      tool: entry.tool,
      score: asked.reduce(
        (sum, word) =>
          sum +
          (rarity.get(word) ?? 0) *
            ((entry.name.has(word) ? 3 : 0) + (entry.rest.has(word) ? 1 : 0)),
        0,
      ),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((match) => match.tool);
}

/** The system a tool belongs to, read the way `grantedToolGuidance` reads it. */
export function systemOf(name: string): string {
  const parts = name.replace(/^mcp__/, "").split("__");
  return parts.length > 1 ? (parts[0] as string) : "this deployment";
}

/** A description cut to one readable line, between characters and never inside one. */
function brief(description: string): string {
  const line = description.replace(/\s+/g, " ").trim();
  const characters = Array.from(line);
  return characters.length <= 200
    ? line
    : `${characters.slice(0, 199).join("")}…`;
}

/**
 * The tool that finds the others, over exactly the tools that wait.
 *
 * Its answer lists each tool as `- <name>: <description>`, and that line is also how
 * {@link loadedBySearch} knows which tools to send next: whatever this returned is in the
 * conversation, so a tool found three turns ago is still sent today, with nothing remembered
 * anywhere but the history every replica already reads.
 */
export function searchToolsTool(waiting: readonly GrantedTool[]): GrantedTool {
  let index: Indexed[] | undefined;
  const systems = new Map<string, number>();
  for (const tool of waiting)
    systems.set(
      systemOf(tool.name),
      (systems.get(systemOf(tool.name)) ?? 0) + 1,
    );
  return {
    name: SEARCH_TOOLS,
    ref: `openbot/${SEARCH_TOOLS}`,
    description: [
      "Find tools you hold that are not in front of you yet.",
      "You hold more tools than fit at once. Describe what you need in a few words, naming the action and",
      "the thing it acts on (for example 'list orders' or 'create issue'). The tools it returns can be",
      "called from your next step, by their names. Search again in other words when none of them fits.",
      "Searching runs nothing.",
    ].join(" "),
    parameters: z.object({
      query: z
        .string()
        .describe(
          "What you need to do, in a few words. For example: list orders.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(SEARCH_RESULTS_LIMIT)
        .optional()
        .describe(`How many tools to return. ${SEARCH_RESULTS} when left out.`),
    }),
    execute: async (args) => {
      const { query = "", limit = SEARCH_RESULTS } =
        args && typeof args === "object"
          ? (args as { query?: string; limit?: number })
          : {};
      index ??= waiting.map(indexed);
      const found = rankIndexed(String(query), index, limit);
      if (found.length === 0)
        return [
          `No tool matched "${query}".`,
          `Tools you can search: ${[...systems].map(([system, count]) => `${system} (${count})`).join(", ")}.`,
          "Try other words, naming the action and the thing it acts on.",
        ].join("\n");
      return [
        `Found ${found.length} tools for "${query}". Call them from your next step:`,
        ...found.map((tool) => `- ${tool.name}: ${brief(tool.description)}`),
      ].join("\n");
    },
  };
}

/** The text of a tool result, in whichever shape the AI SDK or a replayed history carries it. */
function resultText(output: unknown): string {
  if (output && typeof output === "object" && "value" in output) {
    const value = (output as { value: unknown }).value;
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
  }
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

/**
 * The waiting tools this conversation has already found or called, most recent first.
 *
 * Read from the prompt the model is about to be sent, which holds this run's own earlier steps and
 * every turn replayed before it. A tool the model already called is counted too, because a provider
 * shown a call to a tool it was never sent has nothing to read that call against.
 */
export function loadedBySearch(
  prompt: Prompt,
  waiting: ReadonlySet<string>,
): string[] {
  const seen = new Map<string, number>();
  let position = 0;
  for (const message of prompt) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as PromptPart[]) {
      position += 1;
      if (part.type === "tool-call") {
        if (part.toolName && waiting.has(part.toolName))
          seen.set(part.toolName, position);
      } else if (
        part.type === "tool-result" &&
        part.toolName === SEARCH_TOOLS
      ) {
        const text = resultText(part.output);
        for (const name of waiting)
          if (text.includes(`- ${name}:`)) seen.set(name, position);
      }
    }
  }
  return [...seen].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/**
 * The tools one model step is sent: everything that does not wait, then what has been found.
 *
 * Found tools fill only the room left under {@link MODEL_TOOL_LIMIT}, newest first, so a long
 * conversation that has searched its way through a whole app sends the tools it found lately and
 * not a request the provider refuses. Order is kept as the runtime built it.
 */
export function toolsForStep(
  tools: readonly ModelTool[] | undefined,
  prompt: Prompt,
  waiting: ReadonlySet<string>,
): ModelTool[] | undefined {
  if (!tools || waiting.size === 0) return tools ? [...tools] : tools;
  const waits = (tool: ModelTool) =>
    tool.type === "function" && waiting.has(tool.name);
  const room = Math.max(
    0,
    MODEL_TOOL_LIMIT - tools.filter((tool) => !waits(tool)).length,
  );
  const found = new Set(loadedBySearch(prompt, waiting).slice(0, room));
  return tools.filter((tool) => !waits(tool) || found.has(tool.name));
}

/**
 * A model that is sent, on each step, only the tools {@link toolsForStep} chooses.
 *
 * A wrapper around the model and not a change to the agent, because the runtime fixes a run's tools
 * when the run starts and offers no hook between steps. Every step of a run passes through the
 * model, so this is the one place that sees each step's prompt before it is sent. The runtime still
 * registers and executes every tool; this only decides which definitions go up.
 */
export function withToolSearch(
  model: SearchingModel,
  waiting: ReadonlySet<string>,
): SearchingModel {
  const narrowed = (options: CallOptions): CallOptions => ({
    ...options,
    tools: toolsForStep(options.tools, options.prompt, waiting),
  });
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => model.doGenerate(narrowed(options)),
    doStream: (options) => model.doStream(narrowed(options)),
  };
}

/** Whether a resolved model is one this module can wrap. */
export function isSearchingModel(model: unknown): model is SearchingModel {
  return (
    typeof model === "object" &&
    model !== null &&
    (model as { specificationVersion?: unknown }).specificationVersion === "v3"
  );
}
