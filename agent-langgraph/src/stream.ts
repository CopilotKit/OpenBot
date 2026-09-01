/**
 * One run's framework events, read onto the AG-UI wire.
 *
 * Its own module for the reason `history.ts`, `deltas.ts` and `model-options.ts` are: `index.ts`
 * calls `serve()` at module scope, so importing `runAgent` to reach this logic binds a port. The
 * translation is where a run's shape is decided — when a message opens and closes, when a tool call
 * is reported, and what a run that produced nothing a person can see ends on — which is exactly the
 * part worth testing without a model.
 */
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { AIMessage } from "@langchain/core/messages";
import { textOfChunk } from "./deltas";

/**
 * The line a run ends on when it produced nothing a person can see.
 *
 * A reply with no text and no tool call ends the graph — the conditional edge sees no calls and
 * stops — and without a line the person is left looking at a RUN_STARTED/RUN_FINISHED pair carrying
 * nothing between them and no reason. Strict providers do this on a run they will not answer.
 *
 * It is emitted HERE, on the wire, and not by substituting a message into the graph's state. Only
 * the model's own stream and the tool node reach this reader; a message a node returns is never
 * streamed, so a fallback put into state is a fallback the surface never sees. "Visible" is decided
 * by {@link textOfChunk}, the same rule the streamed deltas use, so a reply that is only a reasoning
 * summary — text the person is never meant to see — counts as empty here too.
 */
export const EMPTY_REPLY_FALLBACK =
  "The model returned an empty reply and the run ended without an answer. This can happen with a strict provider; try asking again.";

/** The framework's streamed events, in the shape this reader looks at. */
export interface RunStreamEvent {
  event: string;
  name?: string;
  data?: {
    chunk?: { content?: unknown };
    output?: unknown;
  };
}

/**
 * Translate one run's framework events into AG-UI events, each sent through `send`.
 *
 * The caller opens the run with RUN_STARTED and closes the stream; this fills the middle and ends it
 * with RUN_FINISHED, or RUN_ERROR if anything threw. `makeEvents` is called inside the try so a
 * failure building the graph or opening the stream is reported the same way as a failure mid-stream,
 * which is the single try the inline version had.
 */
export async function streamRun(
  makeEvents: () => Promise<AsyncIterable<RunStreamEvent>>,
  input: Pick<RunAgentInput, "runId" | "threadId">,
  send: (event: BaseEvent) => void,
): Promise<void> {
  /*
   * One message id per stretch of prose.
   *
   * A run is several turns now: the Bot may speak, call a tool, read the result and speak again.
   * Reusing one id reopens a message the surface has already closed, and the second half of the
   * answer is dropped.
   */
  let messageIndex = 0;
  let messageId = `msg_${input.runId}_0`;
  let textOpen = false;
  const closeText = () => {
    if (!textOpen) return;
    send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
    textOpen = false;
    messageIndex += 1;
    messageId = `msg_${input.runId}_${messageIndex}`;
  };

  /*
   * Whether anything a person can see reached the wire.
   *
   * A run that ends having sent neither a line of prose nor a tool call is the silent empty reply,
   * and gets EMPTY_REPLY_FALLBACK rather than a bare RUN_FINISHED. A tool call counts because the
   * surface has something to do with it — draw it, or put it to a person — even though this process
   * sent no result with it.
   */
  let sentVisibleText = false;
  let sentToolCall = false;

  try {
    const events = await makeEvents();

    // Accumulated rather than emitted per chunk, because a tool call's arguments arrive in
    // fragments and AG-UI wants one call. The framework hands back assembled `tool_calls` on the
    // final message, which is precisely the plumbing agent-bot does by hand.
    /** Calls seen on the way past, so a result can be paired with the arguments it answered. */
    const pending = new Map<
      string,
      { name: string; args: Record<string, unknown> }
    >();

    for await (const event of events) {
      if (event.event === "on_chat_model_stream") {
        /*
         * Both content shapes, because the API decides which one arrives.
         *
         * Chat completions streams a string. The Responses API streams content blocks, so reading
         * only the string shape dropped every delta and the run finished having said nothing — the
         * "no text at all on gpt-5.6-*" this repository documents in `.env.example` and
         * `docker-compose.yml`.
         */
        const text = textOfChunk(event.data?.chunk?.content);
        if (!text) continue;

        if (!textOpen) {
          send({
            type: "TEXT_MESSAGE_START",
            messageId,
            role: "assistant",
          } as BaseEvent);
          textOpen = true;
        }
        send({
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: text,
        } as BaseEvent);
        sentVisibleText = true;
      }

      if (event.event === "on_chat_model_end") {
        const output = event.data?.output as AIMessage | undefined;
        if (output) {
          for (const call of output.tool_calls ?? []) {
            pending.set(call.id ?? call.name, {
              name: call.name,
              args: (call.args ?? {}) as Record<string, unknown>,
            });
          }
        }
      }

      /*
       * The tools node finished. Reported here, in order, rather than collected for the end: the
       * surface draws a conversation, and a call arriving after the answer it informed reads as
       * though the Bot spoke first and did the work afterwards.
       */
      if (event.event === "on_chain_end" && event.name === "tools") {
        const output = event.data?.output as
          | { messages?: { tool_call_id?: string; content?: unknown }[] }
          | undefined;
        // Prose and tool calls cannot interleave inside one message.
        closeText();
        for (const message of output?.messages ?? []) {
          const id = message.tool_call_id ?? "";
          const call = pending.get(id);
          if (!call) continue;
          send({
            type: "TOOL_CALL_START",
            toolCallId: id,
            toolCallName: call.name,
          } as BaseEvent);
          send({
            type: "TOOL_CALL_ARGS",
            toolCallId: id,
            delta: JSON.stringify(call.args),
          } as BaseEvent);
          send({ type: "TOOL_CALL_END", toolCallId: id } as BaseEvent);
          send({
            type: "TOOL_CALL_RESULT",
            messageId: `${id}-result`,
            toolCallId: id,
            content: String(message.content ?? ""),
            role: "tool",
          } as BaseEvent);
          sentToolCall = true;
          pending.delete(id);
        }
      }
    }

    closeText();

    /*
     * Calls this process did not run, which is what a tool the surface owns looks like from here.
     *
     * The graph ends the run on one of those rather than inventing a result, so the `tools` node
     * never fires and the loop above never reports the call. Without this the run is a clean
     * RUN_STARTED/RUN_FINISHED pair carrying nothing at all: the person's message sits there with
     * no answer under it, the surface never learns there was a browser action to execute, and
     * because an empty run is not an error by the protocol, nothing says so. No result is sent
     * with them; producing it is the surface's half, and it begins the next run holding it.
     */
    for (const [id, call] of pending) {
      send({
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: call.name,
      } as BaseEvent);
      send({
        type: "TOOL_CALL_ARGS",
        toolCallId: id,
        delta: JSON.stringify(call.args),
      } as BaseEvent);
      send({ type: "TOOL_CALL_END", toolCallId: id } as BaseEvent);
      sentToolCall = true;
    }
    pending.clear();

    /*
     * Nothing a person can see was produced: no prose, and no call for the surface to run or draw.
     * End on a visible line rather than a silent RUN_FINISHED, which is the whole point of noticing.
     */
    if (!sentVisibleText && !sentToolCall) {
      send({
        type: "TEXT_MESSAGE_START",
        messageId,
        role: "assistant",
      } as BaseEvent);
      send({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: EMPTY_REPLY_FALLBACK,
      } as BaseEvent);
      send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
    }

    send({
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent);
  } catch (error) {
    // A text message left open would strand the surface mid-message, so it is closed before the
    // error is reported. agent-bot has the same hazard and the same ordering.
    if (textOpen) {
      send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
    }
    send({
      type: "RUN_ERROR",
      message:
        error instanceof Error ? error.message : "The Bot could not answer.",
    } as BaseEvent);
  }
}
