import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { StatusLine } from "./SetupProgress";

/**
 * What happens next and why, said before macOS asks for the person's password. In plain words: the
 * person doesn't know what Podman is, and needn't. The log names it.
 */
export const PODMAN_EXPLAINED =
  "OpenBot needs one more piece of software to run on this computer. macOS asks for your password once to install it.";

/** The heading over that explanation. */
export const PODMAN_HEADING = "Install the software OpenBot needs";

/**
 * Continue, under the explanation: Install raises macOS's password prompt (`install::GoAhead`).
 *
 * The prompt used to come up by itself, over the Account step, before the person knew what Podman
 * was. Apple's guidance for a screen shown before a system prompt is one button, titled to say it
 * goes on to the prompt ("Continue", never "Allow"), and no way past it but the prompt. Install
 * waits for nothing else, so there is nothing else to offer here.
 *
 * Give it `key={asking}`: asked again after the prompt was closed without a password, Continue
 * works again.
 */
export function ContinueToPodman() {
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
        Continue
      </button>
    </div>
  );
}

/**
 * Before macOS asks for a password to install Podman, on a screen about something else (Install,
 * Start): the card a step that waits on the person gets (`.local-alert.needs`), saying what happens
 * next and why, Install's own line about it unless `quiet`, and Continue.
 */
export function PodmanGoAhead({
  asking,
  quiet = false,
}: {
  /** Install's line while it waits (`goAheadNow`). */
  asking: string;
  /** Install's line is said already, in its row on this screen. */
  quiet?: boolean;
}) {
  return (
    <section className="local-alert needs" aria-label={PODMAN_HEADING}>
      <h2>{PODMAN_HEADING}</h2>
      <p>{PODMAN_EXPLAINED}</p>
      {!quiet && <StatusLine working={false}>{asking}</StatusLine>}
      <ContinueToPodman key={asking} />
    </section>
  );
}
