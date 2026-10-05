/** Synchronous admission, asynchronous draining. No work is queued or replayed. */
export function createActionBarrier() {
  let closed = false;
  let active = 0;
  const waiters = new Set<() => void>();
  return {
    enter(): () => void {
      if (closed)
        throw new Error("Action admission is closed for this computer.");
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        if (active === 0) for (const wake of [...waiters]) wake();
      };
    },
    close() {
      closed = true;
    },
    open() {
      closed = false;
    },
    pending() {
      return active;
    },
    drain(timeoutMs = 30_000): Promise<void> {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(
            new Error(
              "An admitted action is still finishing; human control has not been granted. Try taking control again.",
            ),
          );
        }, timeoutMs);
        waiters.add(wake);
      });
    },
  };
}
