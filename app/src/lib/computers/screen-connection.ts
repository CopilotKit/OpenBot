/** Small transport lifecycle shared by the live viewer and deterministic reconnect tests. */
export type ScreenSocket = {
  onopen: (() => void | Promise<void>) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  close: () => void;
};
type Options = {
  open: () => ScreenSocket;
  verifyOwnership: () => Promise<boolean>;
  onReady: (ready: boolean) => void;
  onProblem: (problem: string | null) => void;
  onDisconnect: () => void;
  onMessage: (event: { data: unknown }) => void;
  schedule?: (run: () => void, delay: number) => () => void;
};
const BACKOFF = [500, 1000, 2000, 4000, 8000];
export function connectScreen(options: Options) {
  let stopped = false;
  let attempts = 0;
  let socket: ScreenSocket | undefined;
  let cancelTimer: (() => void) | undefined;
  const schedule =
    options.schedule ??
    ((run, delay) => {
      const timer = setTimeout(run, delay);
      return () => clearTimeout(timer);
    });
  const connect = () => {
    if (stopped) return;
    const current = options.open();
    socket = current;
    let disconnected = false;
    const owns = () => !stopped && socket === current && !disconnected;
    const disconnect = () => {
      if (!owns()) return;
      disconnected = true;
      options.onDisconnect();
      options.onReady(false);
      const delay = BACKOFF[attempts++];
      if (delay === undefined) {
        options.onProblem(
          "The live screen is disconnected. Retry to reconnect.",
        );
        return;
      }
      options.onProblem("Reconnecting to the live screen…");
      cancelTimer = schedule(connect, delay);
    };
    current.onopen = async () => {
      // The initial mount receives freshly polled ownership from its parent. Reconnect must refresh it.
      const permitted =
        attempts === 0 || (await options.verifyOwnership().catch(() => false));
      if (!owns()) return;
      options.onProblem(null);
      options.onReady(permitted);
    };
    current.onmessage = (event) => {
      if (!owns()) return;
      let message: { type?: string; error?: string } | undefined;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        /* Frame parser handles malformed input. */
      }
      if (message?.type === "error") {
        // The server deliberately leaves superseded sockets open. Never compete with the other tab.
        if (
          /superseded|another (?:viewer|screen)|opened elsewhere|watched somewhere else|another tab/i.test(
            message.error ?? "",
          )
        ) {
          stopped = true;
          cancelTimer?.();
          options.onDisconnect();
          options.onReady(false);
          options.onProblem(
            message.error ??
              "This screen is open in another tab. Retry to take it here.",
          );
          current.close();
          return;
        }
      }
      // A frame means this socket recovered, so the next drop starts the backoff over. Without
      // this, drops a viewer had already recovered from used up the retries for good.
      if (message?.type === "frame") attempts = 0;
      options.onMessage(event);
    };
    current.onerror = () => {
      disconnect();
      current.close();
    };
    current.onclose = disconnect;
  };
  connect();
  return {
    stop: () => {
      stopped = true;
      cancelTimer?.();
      options.onReady(false);
      socket?.close();
    },
  };
}
