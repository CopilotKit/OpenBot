import { useSyncExternalStore } from "react";
import {
  cancelControl,
  type ControlState,
  readControl,
  releaseControl,
  takeControl,
} from "./control";

type Action = "take" | "release" | "cancel";
type Snapshot = {
  control: ControlState | null;
  busy: boolean;
  problem: string | null;
};
const EMPTY: Snapshot = { control: null, busy: false, problem: null };
type ControlStore = {
  getSnapshot: () => Snapshot;
  refresh: () => Promise<void>;
  change: (action: Action) => Promise<boolean>;
  subscribe: (listener: () => void) => () => void;
};
const stores = new Map<string, ControlStore>();

/** One authoritative poll and mutation gate per visible Bot, shared by chat, sidebar and modal. */
function createControlStore(computerId: string): ControlStore {
  let snapshot = EMPTY;
  let version = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reading: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    const mine = version;
    reading?.abort();
    const abort = new AbortController();
    reading = abort;
    const control = await readControl(
      computerId,
      undefined,
      abort.signal,
    ).catch(() => null);
    if (reading === abort) reading = undefined;
    if (abort.signal.aborted || mine !== version || snapshot.busy) return;
    publish({
      ...snapshot,
      control,
      problem: control
        ? snapshot.problem?.startsWith("Reconnecting:")
          ? null
          : snapshot.problem
        : "Reconnecting: browser ownership could not be checked. Input is paused.",
    });
  };
  // Keep the same store through Strict Mode resubscriptions and pending mutations.
  const disposeWhenUnused = () =>
    queueMicrotask(() => {
      if (!listeners.size && !snapshot.busy && stores.get(computerId) === store)
        stores.delete(computerId);
    });
  const change = async (action: Action): Promise<boolean> => {
    if (snapshot.busy || snapshot.control?.transitioning) return false;
    const control = snapshot.control;
    const requestId = control?.request?.id;
    if (action !== "take" && !requestId) {
      publish({
        ...snapshot,
        problem:
          "The handoff request could not be identified. Retry the connection.",
      });
      return false;
    }
    version++;
    reading?.abort();
    publish({ ...snapshot, busy: true, problem: null });
    try {
      const next =
        action === "take"
          ? await takeControl(
              computerId,
              control?.requested ? requestId : undefined,
            )
          : requestId
            ? action === "release"
              ? await releaseControl(computerId, requestId)
              : await cancelControl(computerId, requestId)
            : null;
      publish({
        control: next ?? control,
        busy: false,
        problem: next
          ? null
          : "Control could not be changed. Check the connection and retry.",
      });
      return next !== null;
    } catch {
      publish({
        ...snapshot,
        busy: false,
        problem: "The computer could not be reached. Retry when it reconnects.",
      });
      return false;
    } finally {
      disposeWhenUnused();
    }
  };
  const store: ControlStore = {
    getSnapshot: () => snapshot,
    refresh,
    change,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (timer === undefined) {
        if (!snapshot.busy) void refresh();
        timer = setInterval(() => {
          if (!snapshot.busy && !reading) void refresh();
        }, 1000);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        clearInterval(timer);
        timer = undefined;
        reading?.abort();
        version++;
        disposeWhenUnused();
      };
    },
  };
  return store;
}
const noSubscription = () => () => undefined;
const emptySnapshot = () => EMPTY;
export function useComputerControl(computerId: string, enabled = true) {
  let store = enabled ? stores.get(computerId) : undefined;
  if (enabled && !store) {
    store = createControlStore(computerId);
    stores.set(computerId, store);
  }
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return { ...snapshot, change: store?.change, refresh: store?.refresh };
}
