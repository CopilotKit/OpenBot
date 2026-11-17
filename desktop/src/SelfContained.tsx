import { IconDeviceLaptop } from "@tabler/icons-react";
import { ExternalLink } from "./ExternalLink";
// OpenBot for Business's one booking link. The only line to change when it moves to a shared module.
import { BOOK_A_DEMO } from "./Welcome";

/** The heading Start shows while it updates the OpenBot that runs on this computer. */
export const UPDATING_SELF_CONTAINED = "Updating OpenBot (Self-Contained)";

/**
 * Why updating OpenBot shows a screen at all, under the update's progress: this OpenBot runs
 * entirely on this computer, so its update runs here too. Then OpenBot for Business, for teams and
 * production, and one link to book a demo, opened in the person's browser. A consumer app updates
 * without a screen like this one, and this says why this one has it.
 *
 * Under the progress and quieter than it: nothing to click to go on, and it fits the setup window's
 * default size with the progress card above it. While Docker Desktop's hand-off makes the progress
 * taller, it leaves out its middle sentence (`styles.css`), so the card still doesn't scroll.
 */
export function SelfContainedNote() {
  return (
    <section
      className="self-contained"
      aria-labelledby="self-contained-heading"
    >
      <div className="mark-tile mark-icon" aria-hidden="true">
        <IconDeviceLaptop stroke={1.75} />
      </div>
      <div className="self-contained-words">
        <h2 id="self-contained-heading">Everything runs on this computer</h2>
        <p className="self-contained-why">
          This OpenBot is self-contained. Its services run here, so they update
          here too.
        </p>
        <p>
          For teams and production, OpenBot for Business runs in OpenBot Cloud,
          your own cloud or on-prem.{" "}
          <ExternalLink href={BOOK_A_DEMO}>Book a demo</ExternalLink>
        </p>
      </div>
    </section>
  );
}
