import type { ReactNode } from "react";
import { EarlyDownloadsLine } from "./EarlyDownloads";
import { ExternalLink } from "./ExternalLink";

/** OpenBot's one booking link. */
export const BOOK_A_DEMO = "https://open.bot/business";

/**
 * What OpenBot is, before it asks for anything.
 *
 * Three short paragraphs, in this order: what this OpenBot is (self-contained, all on this
 * computer, its backend too), how long setup takes, and where OpenBot for Business runs, with the
 * one booking link. Usage data is not said here: it is the last screen's choice
 * (`UsageDataChoice`).
 *
 * The big downloads start while this screen shows, before Install is clicked, and its line says how
 * far they are (`EarlyDownloadsLine`). Once they are done it says nothing: Install is the next step
 * either way.
 */
export function Welcome({
  onInstall,
  failure,
}: {
  onInstall: () => void;
  /** A failure from setup itself, shown inside this card rather than under it. */
  failure?: ReactNode;
}) {
  return (
    <div className="sheet">
      <div className="lockup">
        <div className="orb" aria-hidden="true" />
        <span>
          OpenBot
          <sup className="trademark" aria-hidden="true">
            ™
          </sup>
        </span>
      </div>
      <h1>Set up OpenBot (self-contained)</h1>
      <p className="lede big">
        This version of OpenBot is fully self-contained and runs entirely on
        your computer, including the OpenBot backend.
      </p>
      <p className="lede big">
        Depending on your internet speed, setup can take between 1 and 10
        minutes.
      </p>
      <p className="lede big">
        In production, <strong>OpenBot for Business</strong> runs on your own
        infrastructure with Kubernetes, or on OpenBot Cloud.{" "}
        <ExternalLink href={BOOK_A_DEMO}>Book a demo</ExternalLink> for early
        access.
      </p>
      <div className="row">
        <button type="button" onClick={onInstall}>
          Install
        </button>
      </div>
      <EarlyDownloadsLine firstScreen />
      {failure}
    </div>
  );
}
