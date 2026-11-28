import { useCopilotKit, ɵcreateThreadStore } from "@copilotkit/react-core/v2";
import { useEffect, useLayoutEffect, useState } from "react";

/**
 * Live updates about the open thread, heard under the id the chat has for it.
 *
 * The chat reconnects by itself when a run starts on its thread from somewhere else: another tab,
 * another device, a routine. It learns of that run from a live update that names the thread, and
 * it reconnects only when that name is its own thread id.
 *
 * A thread has two ids. `threadId` is the one this app keeps and sends. `liveThreadId` is the one
 * live updates carry, and the server says what it is when it answers about the thread. In the
 * organization `default` the two are the same. Anywhere else they differ, so an update about the
 * open thread names an id the chat has never seen, and the chat would sit on a finished answer
 * until the page was loaded again.
 *
 * So the updates are given to the chat under `threadId`. The chat asks the registry for a thread
 * store for its Bot before it makes one of its own, and listens to whichever it gets. The store
 * registered here is the same kind the chat would have made, with one difference: an update that
 * names `liveThreadId` reaches the listener naming `threadId`.
 */

/** The two ids of one thread. */
export type ThreadIds = { threadId: string; liveThreadId: string };

/** What a store tells a listener about a run on some thread. */
type RunActivity = { threadId: string };

/** The part of a thread store this module changes. Everything else is left as it is. */
type RunActivitySource = {
  subscribeToRunActivity?(
    listener: (notification: RunActivity) => void,
  ): unknown;
};

/** An update as the chat should hear it: about `threadId` when it names the thread's live id. */
export function underOwnThreadId<Notification extends RunActivity>(
  notification: Notification,
  ids: ThreadIds,
): Notification {
  return notification.threadId === ids.liveThreadId &&
    ids.liveThreadId !== ids.threadId
    ? { ...notification, threadId: ids.threadId }
    : notification;
}

/** `store`, with every update about the thread's live id delivered as an update about `threadId`. */
export function hearingUnderOwnThreadId<Store extends RunActivitySource>(
  store: Store,
  ids: ThreadIds,
): Store {
  return new Proxy(store, {
    get(target, property) {
      const subscribe = target.subscribeToRunActivity;
      // A store that announces no runs has nothing to rename.
      if (property !== "subscribeToRunActivity" || !subscribe)
        return Reflect.get(target, property, target);
      return (listener: (notification: RunActivity) => void) =>
        subscribe.call(target, (notification) =>
          listener(underOwnThreadId(notification, ids)),
        );
    },
  });
}

/**
 * Keeps the chat of `agentId` hearing live updates about its thread under the id it has for it.
 *
 * Rendered beside the chat, and only for a thread whose live id is not its own. In the
 * organization `default` the two are the same, nothing is rendered, and the chat listens exactly
 * as it always has.
 */
export function LiveThreadUpdates({
  agentId,
  threadId,
  liveThreadId,
}: ThreadIds & { agentId: string }): null {
  const { copilotkit } = useCopilotKit();
  const [store] = useState(() =>
    ɵcreateThreadStore({ fetch: copilotkit.ɵruntimeFetch }),
  );

  /*
   * Registered before the chat's own effects run. The chat looks for a registered store once,
   * when it starts listening, and a store that arrived after that would never be asked.
   */
  useLayoutEffect(() => {
    store.start();
    copilotkit.registerThreadStore(
      agentId,
      hearingUnderOwnThreadId(store, { threadId, liveThreadId }),
    );
    return () => {
      copilotkit.unregisterThreadStore(agentId);
      store.stop();
    };
  }, [store, copilotkit, agentId, threadId, liveThreadId]);

  // Where the store listens: the runtime's addresses, which are known once it has connected.
  const runtimeUrl = copilotkit.runtimeUrl;
  const wsUrl = copilotkit.intelligence?.wsUrl;
  useEffect(() => {
    store.setContext(runtimeUrl ? { runtimeUrl, wsUrl, agentId } : null);
    return () => store.setContext(null);
  }, [store, runtimeUrl, wsUrl, agentId]);

  return null;
}
