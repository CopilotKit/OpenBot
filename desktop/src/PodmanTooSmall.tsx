import { useEffect, useState } from "react";
import {
  type PodmanPlan,
  podmanMachinePlan,
  resizePodmanMachine,
  type Shortfall,
} from "./localEvalCli";
import { podmanRaisedSaid, podmanResizeCommands } from "./localReadiness";
import { StatusLine } from "./SetupProgress";
import { Command } from "./WindowsBlocker";

/** Said when the native side could not resize the machine and gave no sentence of its own. */
const COULD_NOT =
  "OpenBot couldn't resize your Podman machine. Use the steps below instead.";

/**
 * How setup's Podman machine would be made big enough, for the shortfall it stopped on, once the
 * native side has looked at the machine (`podmanMachinePlan`). Null until then, and whenever a
 * bigger machine isn't the answer: the row's own sentence then stands alone.
 */
export function usePodmanPlan(
  shortfall: Shortfall | undefined,
): PodmanPlan | null {
  const [found, setFound] = useState<{
    of: Shortfall;
    plan: PodmanPlan | null;
  } | null>(null);
  useEffect(() => {
    if (!shortfall) return;
    let current = true;
    podmanMachinePlan(shortfall).then((plan) => {
      if (current) setFound({ of: shortfall, plan });
    });
    return () => {
      current = false;
    };
  }, [shortfall]);
  return shortfall && found?.of === shortfall ? found.plan : null;
}

/**
 * The person's Podman machine is too small for setup: OpenBot offers to make it bigger, and does it
 * only once they click (`machine_size::resize_here`), then sets up again. Where it can't (a disk
 * that is short too, or Podman refused), the same change is three commands, each in its own block
 * with Copy, then Retry.
 */
export function PodmanTooSmall({
  plan,
  shortfall,
  onRetry,
}: {
  plan: PodmanPlan;
  shortfall: Shortfall;
  /**
   * Set up again: once the machine is bigger and running again, or after the person made the
   * change by hand. The card holds Retry, so it is not offered while the machine is restarting.
   */
  onRetry: () => void;
}) {
  const [resizing, setResizing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const offered = plan.forThem && failed === null;
  const commands = podmanResizeCommands(shortfall, plan);
  const heading = offered
    ? "OpenBot can fix this for you"
    : "Make your Podman machine bigger";

  function resize() {
    setResizing(true);
    resizePodmanMachine(plan).then(
      () => onRetry(),
      (error: unknown) => {
        setResizing(false);
        setFailed(typeof error === "string" && error ? error : COULD_NOT);
      },
    );
  }

  return (
    <section
      className="local-alert needs podman-too-small"
      aria-label={heading}
    >
      <h2>{heading}</h2>
      {offered ? (
        <>
          <p>
            Resizing restarts your Podman machine with {podmanRaisedSaid(plan)}.
            Anything running in it stops for a moment and starts again. Nothing
            else about it changes.
          </p>
          {resizing ? (
            <StatusLine>
              Restarting your Podman machine with more room. This takes about a
              minute.
            </StatusLine>
          ) : (
            <div className="row">
              <button type="button" onClick={resize}>
                Resize my Podman
              </button>
              <button type="button" className="quiet" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p>{failed ?? "Run these commands in Terminal, one at a time."}</p>
          <ol className="blocker-steps">
            <li>
              Stop your Podman machine.
              <Command lines={[commands.stop]} />
            </li>
            <li>
              Give it more room.
              <Command lines={[commands.set]} />
            </li>
            <li>
              Start it again.
              <Command lines={[commands.start]} />
            </li>
            <li>Come back here and click Retry.</li>
          </ol>
          <div className="row">
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </div>
        </>
      )}
    </section>
  );
}
