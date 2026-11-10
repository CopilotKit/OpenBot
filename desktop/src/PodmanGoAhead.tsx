import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

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

/** The heading over the offer to pause the person's own Podman. */
export const OWN_PODMAN = "OpenBot needs its own Podman";

/**
 * On a Mac whose own Podman machine OpenBot can't use: what OpenBot will do, and the button that
 * says yes. A Mac runs one Podman machine at a time, so OpenBot's own starts only once the
 * person's is paused, and pausing it is their choice. Nothing is paused until they choose it, and
 * Quit starts theirs again (`own_machine`).
 *
 * Give it `key={offer}`, as `TryPasswordAgain`: offered again later, the button works again.
 */
export function PausePodman({
  offer,
}: {
  /** OpenBot's line while it waits for the go-ahead (`pauseOfferNow`). */
  offer: string;
}) {
  const [sent, setSent] = useState(false);
  // Nothing goes on until the person answers, so the offer and its button are brought into view
  // in a step that scrolls. At the window's smallest size the button sat under the step's pinned
  // foot (`StepFooter`). Only the step's own card scrolls: `scrollIntoView` also moved the window's
  // page, which does not scroll, and cut off the card's top.
  const offered = useRef<HTMLElement>(null);
  useEffect(() => {
    const card = offered.current;
    const sheet = card?.closest(".sheet");
    if (!card || !sheet) return;
    const foot = sheet.querySelector(".step-footer");
    const limit = foot
      ? foot.getBoundingClientRect().top
      : sheet.getBoundingClientRect().bottom;
    const over = card.getBoundingClientRect().bottom - limit;
    if (over > 0) sheet.scrollTop += over;
  }, []);
  return (
    <section
      ref={offered}
      className="local-alert needs"
      aria-label={OWN_PODMAN}
    >
      <h2>{OWN_PODMAN}</h2>
      <p>{offer}</p>
      <div className="row">
        <button
          type="button"
          disabled={sent}
          onClick={() => {
            setSent(true);
            // False when OpenBot was not waiting after all: offer it again rather than hang.
            invoke<boolean>("allow_pause_podman").then(
              (waiting) => {
                if (!waiting) setSent(false);
              },
              () => setSent(false),
            );
          }}
        >
          Pause my Podman
        </button>
      </div>
    </section>
  );
}
