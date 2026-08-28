/**
 * The conversation AG-UI carries, as LangChain's message classes.
 *
 * Its own module so it can be tested without starting a server: `index.ts` calls `serve()` at module
 * scope, so importing it to reach one pure function binds a port. `agent-computer/src/control.ts`
 * was split out for the same reason, to keep state-machine tests away from a browser.
 */
import type { RunAgentInput } from "@ag-ui/core";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { COMPUTER_GUIDANCE, NO_ANSWER_CAME } from "../../shared/bot-prompt";

/*
 * Re-exported so this module's own tests and callers keep reading it from here, while the wording
 * itself lives in `shared` where the other Bot can reach it. Both have to say the same thing.
 */
export { NO_ANSWER_CAME };

/** Translate the conversation AG-UI carries into LangChain's message classes. */
export function toLangChainMessages(input: RunAgentInput): BaseMessage[] {
  const messages: BaseMessage[] = [new SystemMessage(COMPUTER_GUIDANCE)];

  /*
   * Which calls in this history were ever answered.
   *
   * A tool call the surface owns ends the run without a result on purpose: the surface draws it, or
   * puts it to a person, and starts the next run carrying the answer. When nobody answers — a Bot
   * asks for the wheel to get past a sign-in and the person decides they do not need it after all —
   * no answer is ever carried, and the call stays in the history with nothing following it.
   *
   * OpenAI rejects that outright on the NEXT turn: "an assistant message with 'tool_calls' must be
   * followed by tool messages responding to each 'tool_call_id'". So the conversation was not merely
   * stuck on that request, it was finished. Every later message failed the same way, and the only
   * escape was starting a new one, which loses it.
   *
   * Collected up front because an answer arrives as a later message than the call it answers.
   */
  const answered = new Set(
    input.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message as { toolCallId?: string }).toolCallId)
      .filter((id): id is string => Boolean(id)),
  );

  for (const message of input.messages) {
    if (message.role === "user") {
      messages.push(new HumanMessage(String(message.content ?? "")));
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push(new SystemMessage(String(message.content ?? "")));
      continue;
    }
    if (message.role === "tool") {
      // Tool results are appended so the model can continue from the completed call.
      messages.push(
        new ToolMessage({
          tool_call_id: message.toolCallId,
          content: String(message.content ?? ""),
        }),
      );
      continue;
    }
    if (message.role === "assistant") {
      messages.push(
        new AIMessage({
          content: message.content ?? "",
          tool_calls:
            message.toolCalls?.map((call) => ({
              id: call.id,
              name: callDetails(call).name,
              // LangChain wants parsed arguments where AG-UI carries the raw string. A call whose
              // arguments did not parse is passed as empty rather than dropped: the model needs to
              // see that it made the call, or it makes it again.
              args: parseArguments(callDetails(call).arguments),
            })) ?? [],
        }),
      );

      /*
       * Close any of its calls that nothing ever answered, immediately after it.
       *
       * Position is not cosmetic: a tool result has to follow the assistant message that made the
       * call, so these go here rather than being appended at the end. A call answered later in the
       * history is left alone and its real answer arrives in its own turn.
       */
      for (const call of message.toolCalls ?? []) {
        if (call.id && !answered.has(call.id)) {
          messages.push(
            new ToolMessage({
              tool_call_id: call.id,
              content: NO_ANSWER_CAME,
              name: callDetails(call).name,
            }),
          );
        }
      }
    }
  }

  return messages;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A tool call's name and arguments, in whichever dialect it arrived in.
 *
 * TWO SPELLINGS, ONE CALL. AG-UI describes `{id, type: "function", function: {name, arguments}}` and
 * the history store writes `{id, name, args}`. Read back from a thread, every call arrives in the
 * second, so `call.function.name` here did not merely degrade: it threw, and took the run with it.
 */
function callDetails(call: {
  function?: { name?: unknown; arguments?: unknown };
  name?: unknown;
  args?: unknown;
}): { name: string; arguments: string } {
  const name = call.function?.name ?? call.name;
  const args = call.function?.arguments ?? call.args;
  return {
    name: typeof name === "string" && name ? name : "tool",
    arguments:
      typeof args === "string"
        ? args
        : args === undefined || args === null
          ? "{}"
          : JSON.stringify(args),
  };
}
