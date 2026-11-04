import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import {
  type ControlState,
  cancelControl,
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
/** How many reads in a row may fail before input is paused: two, about two seconds. */
const MISSED_READS_BEFORE_PAUSE = 2;

/** One authoritative poll and mutation gate per visible Bot, shared by chat, sidebar and modal. */
function createControlStore(computerId: string): ControlStore {
  let snapshot = EMPTY;
  let version = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reading: AbortController | undefined;
  /** Reads in a row that could not reach the computer. See `refresh`. */
  let failures = 0;
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
    /*
     * One read that did not come back is not news. It used to blank the control state at once, which
     * took the wheel off a person mid-sentence: their keyboard stopped being forwarded and every key
     * they held was let go over there, for a hiccup the next read a second later recovered from. The
     * computer still refuses input from anybody not holding the wheel, whatever this shows.
     */
    failures = control ? 0 : failures + 1;
    if (!control && failures < MISSED_READS_BEFORE_PAUSE && snapshot.control)
      return;
    const problem = control
      ? snapshot.problem?.startsWith("Reconnecting:")
        ? null
        : snapshot.problem
      : "Reconnecting: browser ownership could not be checked. Input is paused.";
    // The same answer as last time changes nothing on screen, so nothing is told. Every view of the
    // computer re-rendered once a second for a state that had not moved.
    if (
      problem === snapshot.problem &&
      JSON.stringify(control) === JSON.stringify(snapshot.control)
    )
      return;
    publish({ ...snapshot, control, problem });
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
  const refreshWhenShown = () => {
    if (!document.hidden && !snapshot.busy && !reading) void refresh();
  };
  const store: ControlStore = {
    getSnapshot: () => snapshot,
    refresh,
    change,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (timer === undefined) {
        if (!snapshot.busy) void refresh();
        // Not while the tab is hidden: nobody is looking, and it is read again the moment they are.
        timer = setInterval(() => {
          if (document.hidden) return;
          if (!snapshot.busy && !reading) void refresh();
        }, 1000);
        document.addEventListener("visibilitychange", refreshWhenShown);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        clearInterval(timer);
        timer = undefined;
        document.removeEventListener("visibilitychange", refreshWhenShown);
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
/**
 * Whether a person other than the signed-in one holds the wheel.
 *
 * The control state names the holder (`heldBy`), and on a Bot shared by several people the wheel in somebody's hands is
 * not necessarily the hands of the person looking: telling them "You have control" and offering Hand back put them
 * at the controls of someone else's session, with their clicks reaching a browser that is recording somebody else. A
 * holder the state does not name (a take from before the wheel knew whose it was) or a signed-in person not known yet
 * reads as the person looking, as every take did before.
 */
export function heldByOther(
  control: ControlState | null,
  me: string | undefined,
): boolean {
  return (
    control?.holder === "human" &&
    control.heldBy !== undefined &&
    me !== undefined &&
    control.heldBy !== me
  );
}

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
  // The app's one client, passed rather than found through a provider: this hook runs in places drawn without one.
  const me = useQuery(currentUserQueryOptions(), queryClient).data?.id;
  return {
    ...snapshot,
    /** Someone other than the signed-in person holds the wheel: nothing here is theirs to drive or hand back. */
    someoneElse: heldByOther(snapshot.control, me),
    change: store?.change,
    refresh: store?.refresh,
  };
}
