import { setupText } from "./setup-locale";
import { type ReactNode, useState } from "react";
import {
  EarlyDownloadsLine,
  earlyDownloadsMeasured,
  useEarlyDownloads,
} from "./EarlyDownloads";
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
 *
 * On a disk too full for OpenBot, Install waits with the line that says so, and is there once the
 * download starts by itself. On Windows F it was pressable at 15 GB free: it built OpenBot's machine,
 * then the next step stopped for space, with less free than before. An Install pressed before the
 * downloads have looked at the disk asks them first (`earlyDownloadsMeasured`).
 */
export function Welcome({
  onInstall,
  failure,
}: {
  onInstall: () => void;
  /** A failure from setup itself, shown inside this card rather than under it. */
  failure?: ReactNode;
}) {
  const downloads = useEarlyDownloads();
  const [checking, setChecking] = useState(false);
  const short = downloads?.state === "short";
  const install = () => {
    setChecking(true);
    void earlyDownloadsMeasured().then((now) => {
      setChecking(false);
      if (now?.state !== "short") onInstall();
    });
  };
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
      <h1>{setupText("Set up OpenBot (self-contained)")}</h1>
      <p className="lede big">
        {setupText(
          "This version of OpenBot is fully self-contained and runs entirely on your computer, including the OpenBot backend.",
        )}
      </p>
      <p className="lede big">
        {setupText(
          "Depending on your internet speed, setup can take between 1 and 10 minutes.",
        )}
      </p>
      <p className="lede big">
        {setupText("In production,")}{" "}
        <strong>{setupText("OpenBot for Business")}</strong>{" "}
        {setupText(
          "runs on your own infrastructure with Kubernetes, or on OpenBot Cloud.",
        )}{" "}
        <ExternalLink href={BOOK_A_DEMO}>
          {setupText("Book a demo")}
        </ExternalLink>{" "}
        {setupText("for early access.")}
      </p>
      <div className="row">
        <button type="button" disabled={short || checking} onClick={install}>
          {setupText("Install")}
        </button>
      </div>
      <EarlyDownloadsLine firstScreen />
      {failure}
    </div>
  );
}
