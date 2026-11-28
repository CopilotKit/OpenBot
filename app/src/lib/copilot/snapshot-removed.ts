import type { AbstractAgent } from "@copilotkit/react-core/v2";

/**
 * The messages a run made and its own snapshot then took away: gone for good, so a read of the
 * stored thread that is a beat behind never puts them back.
 *
 * A MESSAGES_SNAPSHOT is the whole set of the roles it carries. "Entries it repeats replace the
 * client's copies, and ones it leaves out are removed" (docs.ag-ui.com/concepts/events,
 * MessagesSnapshot). AG-UI's client applies it so, and the store compacts a thread's events the same
 * way. But the store is read while it catches up, and a read taken part way through a run holds the
 * run as it stood then, the messages its snapshot later took away included.
 *
 * FOUND IN THE STOCK AG-UI CONFORMANCE SUITE, on LlamaIndex's AG-UI adapter: it streams its answer
 * under one id and ends the run with a snapshot holding the same words under a fresh one
 * (llama-index-protocols-ag-ui 0.5.0: agent.py's `resp_id = uuid4()` for the stream, utils.py's
 * `llama_index_message_to_ag_ui_message` minting the reply's id). The streamed copy was gone from the
 * screen, as the snapshot says, until a read of the store taken half way through that stream brought
 * it back as a message the screen did not have: the answer, then a cut-off copy of it under it.
 *
 * Only a role the snapshot carries: one that carries none of a role "says nothing about that role
 * and the client keeps the messages it already has" (the same page).
 *
 * ONLY WHAT THE SAME RUN MADE. A join's snapshot is the gateway's thread, which can lag the store
 * (`mergeStoredMessages`), so what it leaves out may be newer than it, not removed. A run's own
 * snapshot, at its end, is that run's word on what it said.
 */
export function watchSnapshotRemovals(
  agent: AbstractAgent,
  removed: Set<string>,
): () => void {
  /** The messages there were when the run started: none of them is this run's to take away. */
  let before: ReadonlySet<string> = new Set(agent.messages.map(({ id }) => id));
  const { unsubscribe } = agent.subscribe({
    onRunStartedEvent: ({ messages }) => {
      before = new Set(messages.map(({ id }) => id));
    },
    onMessagesSnapshotEvent: ({ event, messages }) => {
      const kept = new Set(event.messages.map(({ id }) => id));
      // A snapshot that carries none of a role says nothing about that role's messages.
      const roles = new Set<string>(event.messages.map(({ role }) => role));
      for (const message of messages) {
        if (!roles.has(message.role)) continue;
        if (!kept.has(message.id) && !before.has(message.id))
          removed.add(message.id);
      }
    },
  });
  return unsubscribe;
}
