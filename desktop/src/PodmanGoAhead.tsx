import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

/** The heading over a password prompt the person closed. */
export const PASSWORD_AGAIN = "Your password is needed";

/**
 * After the person closed the system's password prompt without a password: what that means, and
 * Try again, which asks at once. Install also asks again by itself after a short wait
 * (`install::ASK_AGAIN_AFTER`), so nobody has to find the button.
 *
 * Never a gate before the prompt. #1385 put Continue there, and the product's call for 1.0.1 was
 * that an install step informs the person and moves forward: the step says "Your Mac will ask for
 * your password so OpenBot can install what it needs to run.", leaves it a moment to be read, and
 * the prompt comes up by itself. This card is only for a prompt that was closed.
 *
 * Give it `key={asking}`: asked again after the prompt was closed again, Try again works again.
 */
export function TryPasswordAgain() {
  const [sent, setSent] = useState(false);
  return (
    <div className="row">
      <button
        type="button"
        disabled={sent}
        onClick={() => {
          setSent(true);
          // False when Install was not waiting after all: offer it again rather than hang.
          invoke<boolean>("allow_podman_install").then(
            (waiting) => {
              if (!waiting) setSent(false);
            },
            () => setSent(false),
          );
        }}
      >
        Try again
      </button>
    </div>
  );
}

/**
 * The closed prompt's card, on whichever screen the person is on: Install's own line about it
 * (`install::podman_declined`), and Try again.
 */
export function PodmanGoAhead({
  asking,
}: {
  /** Install's line while it waits to ask again (`goAheadNow`). */
  asking: string;
}) {
  return (
    <section className="local-alert needs" aria-label={PASSWORD_AGAIN}>
      <h2>{PASSWORD_AGAIN}</h2>
      <p>{asking}</p>
      <TryPasswordAgain key={asking} />
    </section>
  );
}
