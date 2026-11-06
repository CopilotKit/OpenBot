/**
 * Recording a stop OpenBot makes with Intelligence, so the run's summary reads `cancelled` rather
 * than `success`.
 *
 * A browser's Stop reaches Intelligence on the thread's channel and is recorded there. A stop OpenBot
 * makes itself (a person's cancel, a pause, a deadline) goes only to the runner, so Intelligence would
 * count the stopped run as finished. CopilotKit's client records such a stop as `ɵrecordRunStop`, and
 * its Intelligence runner calls the `recordStop` a run was started with when the runner is asked to
 * stop it: the agent is aborted at once, and only the terminal event waits for the record, for at
 * most the runner's own short deadline. A failed record never keeps the run going, and a stop
 * Intelligence relayed to the runner is already recorded, so the runner does not call it then.
 *
 * The runtime OpenBot installs has both halves. A client without `ɵrecordRunStop`, as in
 * `@copilotkit/runtime` 1.83.0, is handed nothing, and a stop works exactly as it did there.
 */

/** A run as Intelligence knows it: its thread, its id, and whose and which agent's it is. */
export type PlatformRun = {
  threadId: string;
  runId: string;
  userId: string;
  agentId: string;
};

/** What a runner calls to record a stop it was asked to make. Aborted at the runner's deadline. */
export type StopRecorder = (signal: AbortSignal) => Promise<void>;

type RecordsRunStop = {
  ɵrecordRunStop?: (
    params: PlatformRun & { signal?: AbortSignal },
  ) => Promise<void>;
};

/**
 * The `recordStop` for one run, or undefined when the client cannot record a stop.
 *
 * Feature-detected rather than typed, so this builds against the release without the method. Looked
 * up again at call time, so the method keeps the client as its receiver. `holdsLock` is read when the
 * stop happens: a turn that has lost its lock is no longer the thread's run, so it sends no stop on a
 * thread another run now holds.
 */
export function stopRecorder(
  client: object,
  run: PlatformRun,
  holdsLock: () => boolean,
): StopRecorder | undefined {
  const platform = client as RecordsRunStop;
  if (typeof platform.ɵrecordRunStop !== "function") return undefined;
  return async (signal) => {
    if (!holdsLock()) return;
    await platform.ɵrecordRunStop?.({ ...run, signal });
  };
}

/**
 * Tell `onStopped` when the runner detaches this agent's run for a stop the caller did not make.
 *
 * An Intelligence runner detaches the run's agent (`detachActiveRun`) only when it is asked to stop the
 * run: a person's Stop that Intelligence relays to it, or the runtime's stop route. It does not detach
 * on a lost lock or a broken socket, which only abort the agent. So a detach the caller did not ask
 * for is somebody's Stop. `stoppedHere` says whether the caller is stopping the run itself, in which
 * case it already knows why. The mark is made before the agent is detached.
 */
export function observeDetachedRun(
  agent: { detachActiveRun?: () => Promise<void> },
  stoppedHere: () => boolean,
  onStopped: () => void,
): void {
  const detach = agent.detachActiveRun;
  if (typeof detach !== "function") return;
  agent.detachActiveRun = () => {
    if (!stoppedHere()) onStopped();
    return detach.call(agent);
  };
}
