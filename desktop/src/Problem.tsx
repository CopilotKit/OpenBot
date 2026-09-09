import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
/**
 * A failure, in both registers, wherever one happens.
 *
 * ONE IMPLEMENTATION, because there is one rule and every screen owes it: the sentence is the
 * headline and the real output lives behind a disclosure. A second copy is how one screen ends up
 * showing an engine dump as its title, and how another ends up rendering `[object Object]` because
 * it stringified a failure that was never a string.
 */
export type RecoveryOffer = {
  ticket: string;
  operation: "read" | "add" | "update" | "delete";
  setting: string;
  label: string;
  explanation: string;
};
export type Problem = {
  said: string;
  detail?: string | null;
  recovery?: RecoveryOffer | null;
};

function validOffer(value: unknown): value is RecoveryOffer {
  if (!value || typeof value !== "object") return false;
  return (
    "ticket" in value &&
    typeof value.ticket === "string" &&
    value.ticket.length > 0 &&
    "operation" in value &&
    ["read", "add", "update", "delete"].includes(String(value.operation)) &&
    "setting" in value &&
    typeof value.setting === "string" &&
    "label" in value &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    "explanation" in value &&
    typeof value.explanation === "string" &&
    value.explanation.length > 0
  );
}

/** A failure owns a one-use native ticket, never the credential it represents. */
export function useCredentialRecovery(
  problem: Problem | null,
  setProblem: (problem: Problem | null) => void,
  action: "Start" | "Ask",
) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const state = useRef({
    epoch: 0,
    active: false,
    busy: false,
    mounted: true,
    ticket: null as string | null,
  });
  state.current.ticket = validOffer(problem?.recovery)
    ? problem.recovery.ticket
    : null;
  const cancel = useCallback(
    (ticket: string | null, epoch: number) => {
      void invoke("cancel_credential_recovery", { ticket }).catch((error) => {
        if (state.current.mounted && state.current.epoch === epoch)
          setProblem(asProblem(error));
      });
    },
    [setProblem],
  );
  const abandon = useCallback(() => {
    const held = state.current;
    if (held.busy) return;
    setMessage("");
    if (held.ticket || held.active) {
      const ticket = held.ticket;
      held.epoch += 1;
      held.active = false;
      held.ticket = null;
      setProblem(null);
      setMessage("");
      cancel(ticket, held.epoch);
    }
  }, [cancel, setProblem]);
  useEffect(() => {
    state.current.mounted = true;
    return () => {
      const held = state.current;
      held.mounted = false;
      held.epoch += 1;
      if (held.ticket || held.active) cancel(held.ticket, held.epoch);
    };
  }, [cancel]);
  function begin() {
    const held = state.current;
    if (held.busy || held.active) return null;
    // The ordinary command invalidates the previous native offer before doing work.
    held.ticket = null;
    held.epoch += 1;
    held.active = true;
    setProblem(null);
    setMessage("");
    return held.epoch;
  }
  function current(epoch: number) {
    return state.current.mounted && state.current.epoch === epoch;
  }
  function finish(epoch: number) {
    if (current(epoch)) state.current.active = false;
  }
  async function restore() {
    const held = state.current;
    if (held.busy || held.active || !held.ticket) return;
    const ticket = held.ticket;
    const epoch = ++held.epoch;
    held.busy = true;
    setBusy(true);
    setMessage("");
    try {
      await invoke("recover_credential", { ticket });
      if (current(epoch)) {
        held.ticket = null;
        setProblem(null);
        setMessage(`Access restored for this step. Press ${action} again.`);
      }
    } catch (error) {
      if (current(epoch)) setProblem(asProblem(error));
    } finally {
      if (current(epoch)) {
        held.busy = false;
        setBusy(false);
      }
    }
  }
  return { busy, message, abandon, begin, current, finish, restore };
}

/** Anything thrown, as a problem. A bare string keeps working and reads as it always did. */
export function asProblem(thrown: unknown): Problem {
  if (thrown && typeof thrown === "object" && "said" in thrown) {
    return thrown as Problem;
  }
  return { said: String(thrown) };
}

export function Failure({
  problem,
  recovery,
}: {
  problem: Problem;
  recovery?: Pick<ReturnType<typeof useCredentialRecovery>, "busy" | "restore">;
}) {
  return (
    <div className="blocker" role="alert">
      <h2>That did not finish</h2>
      <p>{problem.said}</p>
      {recovery && validOffer(problem.recovery) && (
        <>
          <p>{problem.recovery.explanation}</p>
          <button
            type="button"
            onClick={recovery.restore}
            disabled={recovery.busy}
          >
            {recovery.busy ? "Waiting for macOS…" : problem.recovery.label}
          </button>
        </>
      )}
      {/* The real output, kept but not the headline. Whoever is debugging opens this; the person
          reading the sentence above never has to. */}
      {problem.detail && (
        <details className="detail-of">
          <summary>Technical details</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * The same two registers where a whole panel would be too much.
 *
 * Used inside the provider rows, which are small and already have a heading. The sentence reads as
 * a caution and the output is still one click away, so a sign-in that fails inside a card is no
 * less diagnosable than one that fails on its own screen.
 */
export function InlineFailure({ problem }: { problem: Problem }) {
  return (
    <div role="alert">
      <p className="caution">{problem.said}</p>
      {problem.detail && (
        <details className="detail-of">
          <summary>Technical details</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
    </div>
  );
}
