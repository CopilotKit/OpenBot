import { useState } from "react";

/**
 * One write at a time, with its failure said out loud. `busy` names the action in flight so a
 * screen can disable every control while it runs.
 */
export function useAction() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function run(name: string, work: () => Promise<unknown>) {
    setBusy(name);
    setError("");
    try {
      await work();
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not complete this action.",
      );
      return false;
    } finally {
      setBusy("");
    }
  }
  return { busy, error, run, setError };
}
