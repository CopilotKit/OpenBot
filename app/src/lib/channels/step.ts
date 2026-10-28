import type { Message } from "@ag-ui/core";
import { researchRoleOfTool } from "@openbot/shared/research";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import {
  connectorName,
  ownToolLabel,
  personToolLabel,
  readToolName,
} from "@/lib/plugins/tool-name";

/**
 * What the line under a conversation's name may say about the step its Bot is on, where the step's
 * own line has no words for it: a plain phrase about the person and their things, in the present,
 * with no ellipsis. Never a tool's identifier, never a server key.
 *
 * Research, the person's mail and calendar, and this deployment's own tools are named by
 * `tool-name.ts`, in the running words their lines use, so the header and the transcript say the
 * same thing at the same moment.
 */
export const STEP_PHRASES = {
  thinking: "Thinking it through",
  browser: "Working in your browser",
  memory: "Checking memory",
} as const;

/** What the line says while the Bot works and no step of its own is running. */
export const THINKING = STEP_PHRASES.thinking;

/**
 * Tools the line does not name, because they are not work the person is waiting on: a question put
 * to the person, and an interface drawn for them to read or fill in (`askForm`, `showBarChart`).
 * While one runs the line says whatever the turn was doing before it.
 */
const UNNAMED_TOOLS = new Set(["ask_person"]);

/**
 * The line's phrase for a running tool call, or null for one it does not name.
 *
 * Read from what the tool does to the person's things: the web, their mail and calendar through any
 * app, their browser, their memory. An app's call that cannot be named that way is named by the app
 * ("Using Notion"), since "Calendar list events" is still an identifier. Anything else is passed
 * over, like the tools above.
 */
export function stepPhrase(name: string): string | null {
  if (UNNAMED_TOOLS.has(name)) return null;
  // A gallery interface: `askForm`, `askChoice`, `showBarChart`, `showTable`.
  if (/^(ask|show)[A-Z]/.test(name)) return null;
  const own = ownToolLabel(name, true);
  if (own) return own;
  if (name.startsWith("computer_")) return STEP_PHRASES.browser;

  const parts = name.split("__");
  const isMcp = parts.length >= 3 && parts[0] === "mcp";
  const server = isMcp ? (parts[1] ?? "") : "";
  const tool = isMcp ? parts.slice(2).join("__") : name;
  if (isMcp && researchRoleOfTool(server, tool))
    return readToolName(name, true).label;
  const personal = personToolLabel(name, "running");
  if (personal) return personal;
  const words = `${server} ${tool}`
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/);
  if (words.some((word) => MEMORY_WORDS.has(word))) return STEP_PHRASES.memory;
  return isMcp ? `Using ${connectorName(server)}` : null;
}

const MEMORY_WORDS = new Set(["memory", "memories", "remember", "recall"]);

/**
 * What `stepFor` needs to know about an approval: the call it holds and how it was decided. The
 * approvals inbox's requests fit it as they are.
 */
export type StepApproval = {
  status: string;
  decision?: string | null;
  action: { toolCallId?: string };
};

/** A call the person declined, or did themselves, does not run here, whatever its result says yet. */
function wontRun(approval: StepApproval): boolean {
  return (
    approval.status === "denied" ||
    approval.decision === "deny" ||
    approval.decision === "handled"
  );
}

/**
 * What the Bot is doing right now, in a phrase for the line under the conversation's name, or null
 * when it has not got the turn.
 *
 * The newest step still waiting on its result, named by `stepPhrase`: "Searching your email", never
 * "Gmail search messages". Steps the line does not name are passed over. Only this turn's steps
 * count: a call from an earlier turn that never got its result is not running, it was cut off. With
 * no step running the Bot is thinking, or writing what it found.
 */
export function stepFor(
  messages: readonly Message[],
  working: boolean,
  approvals: readonly StepApproval[] = [],
): string | null {
  if (!working) return null;
  const items = toVisibleChatItems(messages);
  // The turn began at the person's last message: their words, or files sent without any.
  const turn = items.slice(
    items.findLastIndex(
      (item) =>
        item.kind === "attachments" ||
        (item.kind === "text" && item.role === "user"),
    ) + 1,
  );
  const running = turn
    .flatMap((item) =>
      item.kind === "tool" &&
      item.result === undefined &&
      !approvals.some(
        (approval) =>
          approval.action.toolCallId === item.toolCall.id && wontRun(approval),
      )
        ? [stepPhrase(item.toolCall.function.name)]
        : [],
    )
    .findLast((phrase) => phrase !== null);
  return running ?? THINKING;
}
