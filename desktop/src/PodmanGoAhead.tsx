import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { GoAhead } from "./SetupProgress";

/** The heading over the explanation before macOS asks for the person's password. */
export const PASSWORD_NEXT = "Your Mac will ask for your password";

/** The heading over a password prompt the person closed. */
export const PASSWORD_AGAIN = "Your password is needed";

/**
 * Keep a card that waits on the person in view in a step that scrolls. Nothing goes on until they
 * answer it. At the window's smallest size the button sat under the step's pinned foot
 * (`StepFooter`). Only the step's own card scrolls: `scrollIntoView` also moved the window's page,
 * which does not scroll, and cut off the card's top.
 */
function useKeptInView(offered: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const card = offered.current;
    const sheet = card?.closest(".sheet");
    if (!card || !sheet) return;
    const bring = () => {
      const foot = sheet.querySelector(".step-footer");
      const limit = foot
        ? foot.getBoundingClientRect().top
        : sheet.getBoundingClientRect().bottom;
      const over = card.getBoundingClientRect().bottom - limit;
      if (over > 0) sheet.scrollTop += over;
    };
    bring();
    // Brought into view again when what is above it grows, as the step's lede does once the
    // account check answers: offered while the check ran, the button went back under the foot.
    // Not when the person scrolls, nor as the row under it ticks: only when the card itself moves.
    let top = card.offsetTop;
    const moved =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (card.offsetTop === top) return;
            top = card.offsetTop;
            bring();
          });
    moved?.observe(sheet, { childList: true, subtree: true });
    return () => moved?.disconnect();
  }, [offered]);
}

/**
 * The button that lets Install go on (`allow_podman_install`): Continue before macOS's password
 * prompt, Try again after the person closed it. Install also asks again by itself a short while
 * after a closed prompt (`install::ASK_AGAIN_AFTER`), so nobody has to find Try again. Before the
 * first prompt nothing goes on until Continue.
 *
 * Give it `key={line}`: asked again after the prompt was closed again, the button works again.
 */
export function GoAheadButton({ label }: { label: "Continue" | "Try again" }) {
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
        {label}
      </button>
    </div>
  );
}

/**
 * macOS's password prompt, on whichever screen the person is on: Install's own line about it, and
 * its one button.
 *
 * Before the prompt: what comes next and why, and Continue. The prompt comes up only on Continue.
 * It comes from the system and comes up over every window, so a line on OpenBot's window with a
 * pause after it was no guarantee anybody read it. On the 1.2.0 Mac run the prompt covered the
 * browser's sign-in page while OpenBot's window, and its line, sat behind the browser. A screen
 * before a system prompt explains it, with one button that goes on to the prompt ("Continue").
 *
 * After a prompt closed without a password (`install::podman_declined`): what that means, and Try
 * again.
 */
export function PodmanGoAhead({ goAhead }: { goAhead: GoAhead }) {
  const offered = useRef<HTMLElement>(null);
  useKeptInView(offered);
  const heading = goAhead.beforePrompt ? PASSWORD_NEXT : PASSWORD_AGAIN;
  return (
    <section ref={offered} className="local-alert needs" aria-label={heading}>
      <h2>{heading}</h2>
      <p>{goAhead.line}</p>
      <GoAheadButton
        key={goAhead.line}
        label={goAhead.beforePrompt ? "Continue" : "Try again"}
      />
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
 * Give it `key={offer}`, as `GoAheadButton`: offered again later, the button works again.
 */
export function PausePodman({
  offer,
}: {
  /** OpenBot's line while it waits for the go-ahead (`pauseOfferNow`). */
  offer: string;
}) {
  const [sent, setSent] = useState(false);
  const offered = useRef<HTMLElement>(null);
  useKeptInView(offered);
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
